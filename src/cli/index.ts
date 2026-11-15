import { runEvaluationSuite } from "../lib/agent/evals";
import { OperationalStore } from "../lib/db/store";

async function main() {
  const args = process.argv.slice(2);
  const userId = process.env.DEFAULT_USER_ID || "usr_demo_owner";

  if (args.includes("--eval")) {
    const summary = await runEvaluationSuite();
    console.log("# LedgerPulse — Production Evaluation Scorecard\n");
    console.log(`- Evaluated (UTC): ${summary.evaluated_at}`);
    console.log(
      `- Overall Score: ${(summary.overall_score * 100).toFixed(1)}% (${summary.overall_passed}/${summary.overall_total} checks passed)\n`
    );
    for (const suite of summary.suites) {
      console.log(`## ${suite.category} (${suite.passed}/${suite.total})`);
      for (const c of suite.checks) {
        console.log(`- [${c.passed ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);
      }
      console.log("");
    }
    process.exit(summary.overall_passed === summary.overall_total ? 0 : 1);
  }

  if (args.includes("--metrics")) {
    const store = new OperationalStore();
    const metrics = store.summaryMetrics(userId);
    console.log(JSON.stringify(metrics, null, 2));
    process.exit(0);
  }

  console.log("Usage: tsx src/cli/index.ts [--eval | --metrics]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
