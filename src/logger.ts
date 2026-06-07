import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = join(import.meta.dir, "..", "logs");
mkdirSync(LOGS_DIR, { recursive: true });

function todayFile(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(LOGS_DIR, `${date}.log`);
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}:${ss}.${ms}`;
}

function headersToLines(headers: Headers, indent: string): string {
  const entries: string[] = [];
  headers.forEach((value, key) => entries.push(`${indent}${key}: ${value}`));
  return entries.length ? entries.join("\n") : `${indent}(none)`;
}

function formatBody(body: unknown): string {
  if (body == null) return "    (none)";
  if (typeof body === "string") return `    ${body}`;
  return `    ${JSON.stringify(body, null, 2).split("\n").join("\n    ")}`;
}

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Matched rule name (proxy requests only) */
  rule?: string;
  /** Upstream name (proxy requests only) */
  upstream?: string;
  /** Model used (proxy requests only) */
  model?: string;
  /** Error message (on failure) */
  error?: string;
  /** Client request headers */
  requestHeaders?: Headers;
  /** Client request body (parsed JSON or raw string) */
  requestBody?: unknown;
  /** Upstream response headers */
  responseHeaders?: Headers;
}

export function logRequest(entry: RequestLog): void {
  const lines: string[] = [];

  // ── Summary line ──
  lines.push("─".repeat(100));
  const summary = [
    ts(),
    `${entry.method} ${entry.path}`,
    `${entry.status}`,
    `${entry.durationMs}ms`,
  ];
  if (entry.error) summary.push(`❌ ${entry.error}`);
  if (entry.upstream) summary.push(`→ ${entry.upstream}`);
  if (entry.model) summary.push(`model=${entry.model}`);
  if (entry.rule) summary.push(`rule=${entry.rule}`);
  lines.push(summary.join("  "));

  // ── Request ──
  if (entry.requestHeaders) {
    lines.push("");
    lines.push("  ▼ REQUEST HEADERS");
    lines.push(headersToLines(entry.requestHeaders, "    "));
  }

  if (entry.requestBody !== undefined) {
    lines.push("");
    lines.push("  ▼ REQUEST BODY");
    lines.push(formatBody(entry.requestBody));
  }

  // ── Response ──
  if (entry.responseHeaders) {
    lines.push("");
    lines.push("  ▲ RESPONSE HEADERS");
    lines.push(headersToLines(entry.responseHeaders, "    "));
  }

  lines.push("");
  try {
    appendFileSync(todayFile(), lines.join("\n") + "\n");
  } catch {
    // Silently ignore write failures — logging should never crash the server
  }
}
