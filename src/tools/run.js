import { MAX_BYTES, MAX_COMMAND_BYTES, MAX_LINES, COMMAND_SHELL_NAME } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommand } from "../process.js";
import { recordStats } from "../stats.js";
import { invalidParams, validateInteger } from "./shared.js";

export async function runTool(args) {
  const { command, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof command !== "string" || command.trim() === "") {
    invalidParams("context_run requires a non-empty command string");
  }
  const lineLimit = validateInteger(maxLines, "context_run maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_run maxBytes", 1024, MAX_BYTES);

  const { stdout, durationMs, outputTooLarge } = await runCommand(command);
  const formatted = formatOutput(stdout, lineLimit, byteLimit);
  const totalBytes = outputTooLarge ? Math.max(formatted.totalBytes, MAX_COMMAND_BYTES + 1) : formatted.totalBytes;
  const returnedBytes = formatted.returnedBytes;
  const savedBytes = Math.max(0, totalBytes - returnedBytes);
  const meta = {
    totalLines: formatted.totalLines,
    totalBytes,
    totalBytesKnown: !outputTooLarge,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
    truncated: formatted.truncated || outputTooLarge,
    outputTooLarge,
    durationMs,
    shell: COMMAND_SHELL_NAME,
  };
  await recordStats("context_run", meta);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: meta,
  };
}
