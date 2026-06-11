import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcess } from "../process.js";
import { recordStats } from "../stats.js";
import { savingsMeta, validateInteger } from "./shared.js";

export async function changedFilesTool(args) {
  const { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  const lineLimit = validateInteger(maxLines, "context_changed_files maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_changed_files maxBytes", 1024, MAX_BYTES);
  const started = Date.now();
  const result = await runProcess("git", ["status", "--porcelain=v1"], { cwd: process.cwd(), timeout: 30_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) commandError("git status --porcelain=v1", result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);

  const lines = result.stdout.trimEnd().split("\n").filter(Boolean).map(formatStatusLine);
  const text = lines.join("\n") || "(no changed files)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const meta = { changedFiles: lines.length, totalLines: formatted.totalLines, totalBytes: formatted.totalBytes, ...savingsMeta(formatted), truncated: formatted.truncated, durationMs: Date.now() - started };
  await recordStats("context_changed_files", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function formatStatusLine(line) {
  return `${line.slice(0, 2)} ${line.slice(3)}`;
}
