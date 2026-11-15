import crypto from "crypto";
import { google } from "googleapis";
import { OperationalStore } from "../db/store";
import { readDocument } from "../agent/services";
import { buildIngestionGraph, runBriefing, type ExtractorFn, type ResearcherFn } from "../agent/workflow";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_CLIENT_ID?.trim() && process.env.GMAIL_CLIENT_SECRET?.trim());
}

export function createOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI?.trim() || "http://localhost:3000/api/gmail/callback";
  if (!clientId || !clientSecret) {
    throw new Error("Gmail OAuth credentials (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) are not configured.");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getGmailAuthUrl(userId: string): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_READONLY_SCOPE],
    state: userId,
  });
}

export async function handleGmailCallback(
  code: string,
  userId: string,
  store = new OperationalStore()
): Promise<{ emailAddress: string }> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke prior app access and reconnect with prompt=consent."
    );
  }
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const emailAddress = profile.data.emailAddress || "unknown@gmail.com";

  store.saveOAuthConnection({
    userId,
    provider: "gmail",
    emailAddress,
    refreshToken: tokens.refresh_token,
    scope: GMAIL_READONLY_SCOPE,
  });

  return { emailAddress };
}

export interface IbkrAttachmentPayload {
  messageId: string;
  subject: string;
  receivedAt: string;
  filename: string;
  pdfBuffer: Buffer;
}

export interface GmailFetchResult {
  status: "downloaded" | "skipped_duplicate" | "no_matching_email";
  messageId?: string;
  subject?: string;
  receivedAt?: string;
  filename?: string;
  sha256?: string;
  pdfBuffer?: Buffer;
  existingSnapshotId?: string;
}

function findPdfParts(
  parts: Array<{
    filename?: string | null;
    mimeType?: string | null;
    body?: { attachmentId?: string | null; data?: string | null } | null;
    parts?: unknown[];
  }> = []
): Array<{ filename: string; attachmentId?: string; data?: string }> {
  const found: Array<{ filename: string; attachmentId?: string; data?: string }> = [];
  for (const part of parts) {
    const fname = part.filename || "";
    const isPdf =
      fname.toLowerCase().endsWith(".pdf") || part.mimeType === "application/pdf";
    if (isPdf && part.body && (part.body.attachmentId || part.body.data)) {
      found.push({
        filename: fname || "Daily_Activity_Statement.pdf",
        attachmentId: part.body.attachmentId ?? undefined,
        data: part.body.data ?? undefined,
      });
    }
    if (Array.isArray(part.parts)) {
      found.push(...findPdfParts(part.parts as typeof parts));
    }
  }
  return found;
}

export async function fetchLatestIbkrStatementPdf(params: {
  userId: string;
  store?: OperationalStore;
  query?: string;
  mockAttachment?: IbkrAttachmentPayload;
}): Promise<GmailFetchResult> {
  const store = params.store ?? new OperationalStore();

  // Allow deterministic offline/mock testing without Google Cloud OAuth
  if (params.mockAttachment) {
    const sha256 = crypto.createHash("sha256").update(params.mockAttachment.pdfBuffer).digest("hex");
    const dedup = store.hasProcessedAttachment(params.userId, sha256);
    if (dedup.processed) {
      return {
        status: "skipped_duplicate",
        messageId: params.mockAttachment.messageId,
        subject: params.mockAttachment.subject,
        receivedAt: params.mockAttachment.receivedAt,
        filename: params.mockAttachment.filename,
        sha256,
        existingSnapshotId: dedup.snapshotId,
      };
    }
    return {
      status: "downloaded",
      messageId: params.mockAttachment.messageId,
      subject: params.mockAttachment.subject,
      receivedAt: params.mockAttachment.receivedAt,
      filename: params.mockAttachment.filename,
      sha256,
      pdfBuffer: params.mockAttachment.pdfBuffer,
    };
  }

  const conn = store.getOAuthConnection(params.userId, "gmail");
  if (!conn) {
    throw new Error("Gmail is not connected for this user. Connect Gmail OAuth2 in Automation settings.");
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: conn.refresh_token });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const q =
    params.query ||
    process.env.IBKR_GMAIL_QUERY ||
    'from:donotreply@interactivebrokers.com subject:"Daily Activity Statement" has:attachment filename:pdf';

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 5,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    store.updateOAuthSyncStatus(params.userId, "no_matching_email");
    return { status: "no_matching_email" };
  }

  const msgId = messages[0].id!;
  const msgRes = await gmail.users.messages.get({
    userId: "me",
    id: msgId,
    format: "full",
  });

  const headers = msgRes.data.payload?.headers || [];
  const subject =
    headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "IBKR Daily Activity Statement";
  const internalDate = msgRes.data.internalDate
    ? new Date(Number(msgRes.data.internalDate)).toISOString()
    : new Date().toISOString();

  const pdfParts = findPdfParts(msgRes.data.payload?.parts ? (msgRes.data.payload.parts as never[]) : [msgRes.data.payload as never]);
  if (pdfParts.length === 0) {
    store.updateOAuthSyncStatus(params.userId, "no_pdf_attachment");
    return { status: "no_matching_email" };
  }

  const targetPart = pdfParts[0];
  let base64Data = targetPart.data;
  if (!base64Data && targetPart.attachmentId) {
    const attRes = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: msgId,
      id: targetPart.attachmentId,
    });
    base64Data = attRes.data.data || "";
  }

  const pdfBuffer = Buffer.from(base64Data || "", "base64url");
  const sha256 = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

  const dedup = store.hasProcessedAttachment(params.userId, sha256);
  if (dedup.processed) {
    store.updateOAuthSyncStatus(params.userId, "skipped_duplicate");
    store.logEvent({
      userId: params.userId,
      eventType: "gmail_dedup_skipped",
      message: `Skipped already-ingested IBKR attachment ${targetPart.filename} (sha256: ${sha256.slice(0, 12)}).`,
      severity: "info",
      details: { messageId: msgId, snapshotId: dedup.snapshotId },
    });
    return {
      status: "skipped_duplicate",
      messageId: msgId,
      subject,
      receivedAt: internalDate,
      filename: targetPart.filename,
      sha256,
      existingSnapshotId: dedup.snapshotId,
    };
  }

  store.updateOAuthSyncStatus(params.userId, "downloaded");
  return {
    status: "downloaded",
    messageId: msgId,
    subject,
    receivedAt: internalDate,
    filename: targetPart.filename,
    sha256,
    pdfBuffer,
  };
}

export async function syncAndAnalyzeIbkrFromGmail(params: {
  userId: string;
  store?: OperationalStore;
  query?: string;
  runBriefingAfter?: boolean;
  days?: number;
  maxInstruments?: number;
  language?: "English" | "Chinese";
  extractor?: ExtractorFn;
  researcher?: ResearcherFn;
  mockAttachment?: IbkrAttachmentPayload;
}): Promise<{
  syncStatus: "ingested" | "skipped_duplicate" | "no_matching_email";
  snapshotId?: string;
  runId?: string;
  filename?: string;
  subject?: string;
  instrumentCount?: number;
}> {
  const store = params.store ?? new OperationalStore();
  const fetched = await fetchLatestIbkrStatementPdf({
    userId: params.userId,
    store,
    query: params.query,
    mockAttachment: params.mockAttachment,
  });

  if (fetched.status === "no_matching_email") {
    return { syncStatus: "no_matching_email" };
  }
  if (fetched.status === "skipped_duplicate") {
    return {
      syncStatus: "skipped_duplicate",
      snapshotId: fetched.existingSnapshotId,
      filename: fetched.filename,
      subject: fetched.subject,
    };
  }

  const { text, pages, piiRedactions } = await readDocument(fetched.pdfBuffer!, fetched.filename!);
  if (Object.keys(piiRedactions).length > 0) {
    store.logEvent({
      userId: params.userId,
      eventType: "pii_redacted",
      message: `Sanitized PII fields from ${fetched.filename} before cloud extraction.`,
      severity: "info",
      details: piiRedactions,
    });
  }

  const graph = buildIngestionGraph(params.extractor);
  const ingested = await graph.invoke({ text, pageCount: pages });
  const statement = ingested.statement!;

  // Automated Gmail sync saves as unconfirmed (confirmed=false) until human review,
  // unless downstream policy allows auto-briefing on read-only dashboard.
  const { snapshot_id } = store.saveSnapshot({
    userId: params.userId,
    statement,
    confirmed: false,
    sourceType: "gmail",
  });

  store.recordIngestionJob({
    userId: params.userId,
    sourceType: "gmail",
    sourceMessageId: fetched.messageId,
    attachmentSha256: fetched.sha256!,
    filename: fetched.filename!,
    status: "completed",
    snapshotId: snapshot_id,
  });

  store.logEvent({
    userId: params.userId,
    eventType: "gmail_ibkr_ingested",
    message: `Ingested IBKR statement ${fetched.filename} (${statement.instruments.length} instruments) from Gmail.`,
    severity: "info",
    details: { snapshot_id, messageId: fetched.messageId, pages },
  });

  let runId: string | undefined;
  if (params.runBriefingAfter) {
    const briefing = await runBriefing({
      userId: params.userId,
      statement,
      confirmed: false,
      snapshotId: snapshot_id,
      days: params.days ?? 1,
      maxInstruments: params.maxInstruments ?? 5,
      language: params.language ?? "English",
      researcher: params.researcher,
      store,
    });
    runId = briefing.runId;
  }

  return {
    syncStatus: "ingested",
    snapshotId: snapshot_id,
    runId,
    filename: fetched.filename,
    subject: fetched.subject,
    instrumentCount: statement.instruments.length,
  };
}
