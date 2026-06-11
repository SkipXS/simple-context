import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { usageReport } from "../usage.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

export async function usageReportTool(args) {
  const { maxEvents = 1000, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  const eventLimit = validateInteger(maxEvents, "context_usage_report maxEvents", 1, 10000);
  const lineLimit = validateInteger(maxLines, "context_usage_report maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_usage_report maxBytes", 1024, MAX_BYTES);

  if (Object.keys(args ?? {}).some((key) => !["maxEvents", "maxLines", "maxBytes"].includes(key))) {
    invalidParams("context_usage_report only accepts maxEvents, maxLines, and maxBytes");
  }

  const started = Date.now();
  const report = await usageReport({ maxEvents: eventLimit });
  const formatted = formatOutput(report.text, lineLimit, byteLimit);
  const meta = {
    ...report.meta,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: formatted.truncated,
    durationMs: Date.now() - started,
  };

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}
