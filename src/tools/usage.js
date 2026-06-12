import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { emptyCounter, formatStatsReport, getStats, normalizeCounter, withSavedPercent } from "../stats.js";
import { usageReport } from "../usage.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

export async function usageTool(args) {
  const { mode = "stats", maxEvents = 1000, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (mode !== "stats" && mode !== "report") invalidParams("context_usage mode must be \"stats\" or \"report\"");

  const lineLimit = validateInteger(maxLines, "context_usage maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_usage maxBytes", 1024, MAX_BYTES);
  if (mode === "stats") return statsResult(lineLimit, byteLimit);

  const eventLimit = validateInteger(maxEvents, "context_usage maxEvents", 1, 10000);
  const started = Date.now();
  const report = await usageReport({ maxEvents: eventLimit });
  const formatted = formatOutput(report.text, lineLimit, byteLimit);
  const meta = {
    mode,
    ...report.meta,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: formatted.truncated,
    durationMs: Date.now() - started,
  };

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function statsResult(maxLines, maxBytes) {
  const started = Date.now();
  const currentStats = await getStats();
  const project = process.cwd();
  const projectStats = currentStats.projects[project] ?? { ...emptyCounter(), byTool: {} };
  const byTool = Object.fromEntries(
    Object.entries(projectStats.byTool ?? {}).map(([toolName, toolStats]) => [toolName, withSavedPercent(normalizeCounter(toolStats))]),
  );
  const stats = {
    mode: "stats",
    project,
    ...withSavedPercent(normalizeCounter(projectStats)),
    byTool,
  };
  const formatted = formatOutput(formatStatsReport(stats), maxLines, maxBytes);

  return {
    content: [{ type: "text", text: formatted.text }],
    _meta: {
      ...stats,
      totalLines: formatted.totalLines,
      responseTotalBytes: formatted.totalBytes,
      responseReturnedBytes: formatted.returnedBytes,
      responseSavedBytes: formatted.savedBytes,
      responseSavedPercent: formatted.savedPercent,
      responseEstimatedTokensSaved: formatted.estimatedTokensSaved,
      truncated: formatted.truncated,
      durationMs: Date.now() - started,
    },
  };
}
