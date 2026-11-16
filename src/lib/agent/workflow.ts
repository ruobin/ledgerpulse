import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { OperationalStore } from "../db/store";
import { computeRunTelemetry, type RunTelemetry } from "../telemetry";
import {
  type Instrument,
  type Research,
  type Statement,
  validatedStatement,
} from "./models";
import { describeAiSetup } from "./llm";
import * as services from "./services";

function escapeCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

export function statementToMarkdown(statement: Statement): string {
  const lines = [
    "## Extracted statement instruments",
    "",
    `Type: **${statement.kind}** · Holdings as of: **${statement.as_of ?? "unknown"}** · Reporting period: **${statement.period || "unknown"}**`,
    "",
    "| Symbol | Name | Type | Exchange | Current quantity | Currency | Activity | Page |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const item of statement.instruments) {
    const qty = item.holding_quantity !== null ? item.holding_quantity : "unknown";
    lines.push(
      `| ${[
        item.symbol,
        item.name,
        item.asset_type,
        item.exchange,
        qty,
        item.currency,
        item.activity,
        item.source_page,
      ]
        .map(escapeCell)
        .join(" | ")} |`
    );
  }
  if (statement.warnings.length > 0) {
    lines.push("", "### Warnings", "");
    for (const w of statement.warnings) {
      lines.push(`- ${w}`);
    }
  }
  return lines.join("\n");
}

const IngestionAnnotation = Annotation.Root({
  text: Annotation<string>,
  pageCount: Annotation<number>,
  statement: Annotation<Statement | undefined>,
});

export type ExtractorFn = (text: string) => Promise<Statement>;

export function buildIngestionGraph(extractor: ExtractorFn = (t) => services.extractStatement(t)) {
  const graph = new StateGraph(IngestionAnnotation)
    .addNode("extract_instruments", async (state) => {
      const statement = await extractor(state.text);
      return { statement };
    })
    .addNode("validate_extraction", async (state) => {
      if (!state.statement) {
        throw new Error("Extraction node returned no statement");
      }
      return { statement: validatedStatement(state.statement, state.pageCount) };
    })
    .addEdge(START, "extract_instruments")
    .addEdge("extract_instruments", "validate_extraction")
    .addEdge("validate_extraction", END);

  return graph.compile();
}

const BriefingAnnotation = Annotation.Root({
  userId: Annotation<string>,
  statement: Annotation<Statement>,
  confirmed: Annotation<boolean>,
  snapshotId: Annotation<string | null>,
  days: Annotation<number>,
  language: Annotation<"English" | "Chinese">,
  maxInstruments: Annotation<number>,
  windowStart: Annotation<string>,
  windowEnd: Annotation<string>,
  research: Annotation<Research[]>,
  markdown: Annotation<string>,
  runId: Annotation<string>,
  /** Epoch ms when prepare_window ran; save_report records end-to-end latency from it. */
  startedAtMs: Annotation<number>,
  telemetry: Annotation<RunTelemetry | undefined>,
});

export type ResearcherFn = (
  item: Instrument,
  startIso: string,
  endIso: string,
  language: string
) => Promise<Research>;

export function buildBriefingGraph(
  researcher: ResearcherFn = services.researchInstrument,
  store?: OperationalStore
) {
  const activeStore = store ?? new OperationalStore();

  const graph = new StateGraph(BriefingAnnotation)
    .addNode("prepare_window", async (state) => {
      const end = new Date();
      const start = new Date(end.getTime() - state.days * 24 * 60 * 60 * 1000);
      return {
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        startedAtMs: end.getTime(),
      };
    })
    .addNode("research_news", async (state) => {
      const results: Research[] = [];
      const slice = state.statement.instruments.slice(0, state.maxInstruments);
      for (const item of slice) {
        try {
          const res = await researcher(item, state.windowStart, state.windowEnd, state.language);
          results.push(res);
        } catch (err) {
          results.push({
            instrument: item.symbol || item.name,
            status: "failed",
            markdown: services.safeError(err),
            sources: [],
            search_calls: 0,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            latency_ms: 0,
            excluded_news_count: 0,
          });
        }
      }
      return { research: results };
    })
    .addNode("render_markdown", async (state) => {
      const statement = state.statement;
      const results = state.research ?? [];
      const limited =
        results.length === 0 ||
        results.some((r) => r.status !== "cited") ||
        statement.instruments.length > state.maxInstruments;

      const lines: string[] = [
        "# LedgerPulse — Portfolio & Activity Briefing",
        "",
        `- **Generated (UTC):** ${state.windowEnd}`,
        `- **Requested news window (UTC):** ${state.windowStart} to ${state.windowEnd}`,
        `- **Input:** **${statement.kind}**; holdings as of: **${statement.as_of ?? "unknown"}**`,
        `- **Extraction review:** **${state.confirmed ? "user confirmed" : "not reviewed; verify against the statement"}**`,
        `- **Coverage:** **${limited ? "limited" : "web search returned citations for all researched instruments"}**`,
        "",
        "LedgerPulse generates educational market intelligence scenarios. It has no live pricing, risk profile, or order execution. " +
          "Publication dates and factual relevance are assessed by the model and validated against UTC calendar-day bounds.",
        "",
      ];

      if (statement.kind !== "holdings") {
        lines.push(
          "> **Current positions are unknown.** These are instruments mentioned in statement activity, including instruments that may have been sold. Do not treat this watchlist as an open portfolio.",
          ""
        );
      } else if (statement.as_of) {
        const asOfMs = Date.parse(`${statement.as_of}T00:00:00.000Z`);
        const ageDays = Math.max(0, Math.floor((Date.now() - asOfMs) / (24 * 60 * 60 * 1000)));
        lines.push(`> Holdings snapshot age: **${ageDays} day(s)**. No live broker quote refresh performed.`, "");
      }

      lines.push(statementToMarkdown(statement), "", "## Research and conditional trading ideas", "");

      if (results.length === 0) {
        lines.push("No instruments were identified. No news or trading ideas were generated.", "");
      }

      for (const result of results) {
        lines.push(
          `### ${result.instrument}`,
          "",
          `Research status: **${result.status}**; web search calls: ${result.search_calls}.`,
          ""
        );
        if (result.status === "unverified") {
          lines.push(
            "No search results with verifiable citations were returned. Analysis omitted; rerun or research manually.",
            ""
          );
        } else {
          lines.push(result.markdown, "");
        }
        if (result.sources.length > 0) {
          lines.push("Sources returned by web search:", "");
          for (const src of result.sources) {
            const safeTitle = src.title.replace(/[\[\]\r\n]/g, "");
            lines.push(`- [${safeTitle}](<${src.url}>)`);
          }
          lines.push("");
        }
      }

      const skipped = statement.instruments.slice(state.maxInstruments);
      if (skipped.length > 0) {
        lines.push(
          "## Not researched in this run",
          "",
          `The selected cost limit excluded: ${skipped.map((i) => i.symbol || i.name).join(", ")}.`,
          ""
        );
      }
      lines.push("---", describeAiSetup().footer, "");
      return { markdown: lines.join("\n") };
    })
    .addNode("save_report", async (state) => {
      const model = describeAiSetup().runModel;
      const research = state.research ?? [];
      const { run_id, telemetry } = activeStore.recordRun({
        userId: state.userId,
        snapshotId: state.snapshotId,
        confirmed: state.confirmed,
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        language: state.language,
        model,
        maxInstruments: state.maxInstruments,
        markdown: state.markdown,
        research: research as unknown as Array<Record<string, unknown>>,
        latencyMs: Math.max(0, Date.now() - state.startedAtMs),
      });
      return { runId: run_id, telemetry };
    })
    .addEdge(START, "prepare_window")
    .addConditionalEdges(
      "prepare_window",
      (state) => (state.statement.instruments.length > 0 ? "research" : "empty"),
      { research: "research_news", empty: "render_markdown" }
    )
    .addEdge("research_news", "render_markdown")
    .addEdge("render_markdown", "save_report")
    .addEdge("save_report", END);

  return graph.compile();
}

export async function runBriefing(params: {
  userId?: string;
  statement: Statement;
  confirmed?: boolean;
  snapshotId?: string | null;
  days?: number;
  language?: "English" | "Chinese";
  maxInstruments?: number;
  researcher?: ResearcherFn;
  store?: OperationalStore;
}): Promise<{
  runId: string;
  markdown: string;
  research: Research[];
  telemetry: RunTelemetry;
  windowStart: string;
  windowEnd: string;
}> {
  const days = params.days ?? 7;
  const maxInstruments = params.maxInstruments ?? 3;
  const language = params.language ?? "English";
  // Number.isInteger also rejects NaN, which slips through plain range comparisons.
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 30 ||
    !Number.isInteger(maxInstruments) ||
    maxInstruments < 1 ||
    maxInstruments > 10
  ) {
    throw new Error("Choose 1-30 days and 1-10 instruments.");
  }

  const t0 = performance.now();
  const userId = params.userId || process.env.DEFAULT_USER_ID || "usr_demo_owner";
  const graph = buildBriefingGraph(params.researcher, params.store);
  const result = await graph.invoke({
    userId,
    statement: validatedStatement(params.statement),
    confirmed: Boolean(params.confirmed),
    snapshotId: params.snapshotId ?? null,
    days,
    language,
    maxInstruments,
    windowStart: "",
    windowEnd: "",
    research: [],
    markdown: "",
    runId: "",
    startedAtMs: Date.now(),
    telemetry: undefined,
  });

  const elapsed = Math.round(performance.now() - t0);
  const telemetry =
    result.telemetry ??
    computeRunTelemetry(result.research, describeAiSetup().runModel, elapsed);

  return {
    runId: result.runId,
    markdown: result.markdown,
    research: result.research,
    telemetry,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
  };
}
