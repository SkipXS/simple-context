import * as fs from "node:fs";
import * as path from "node:path";
import { projectKey, projectKeyForPath, usageLogEnabled, USAGE_LOG_FILE, USAGE_LOG_MAX_BYTES } from "./constants.js";
import { chmodPrivateFile, ensurePrivateDir, PRIVATE_FILE_MODE, withFileLock } from "./storage.js";

const MAX_REPORT_EVENTS = 10_000;
const REPORT_READ_BYTES = 5 * 1024 * 1024;
let usageWrite = Promise.resolve();

export function recordUsage(toolName, args, result, error, durationMs) {
  if (!usageLogEnabled()) return;
  const project = projectKey();
  if (!project) return;

  const meta = result?._meta ?? {};
  const response = meta.response ?? meta;
  const event = {
    ts: Date.now(),
    project,
    tool: toolName,
    durationMs,
    ok: !error,
    truncated: Boolean(meta.truncated),
    totalBytes: numberOrUndefined(response.totalBytes),
    returnedBytes: numberOrUndefined(response.returnedBytes),
    savedBytes: numberOrUndefined(response.savedBytes),
    exitCode: numberOrUndefined(meta.exitCode ?? error?.status),
    errorCode: error?.code,
    commandKind: classifyCommand(args?.command),
    args: summarizeArgs(args),
  };

  usageWrite = usageWrite.catch(() => {}).then(async () => {
    try {
      await ensurePrivateDir(path.dirname(USAGE_LOG_FILE));
      await withFileLock(USAGE_LOG_FILE, async () => {
        await fs.promises.appendFile(USAGE_LOG_FILE, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
        await chmodPrivateFile(USAGE_LOG_FILE);
        await pruneUsageLogIfNeeded();
      });
    } catch {
      // Usage logging must never affect tool behavior.
    }
  });
}

async function pruneUsageLogIfNeeded() {
  const stat = await fs.promises.stat(USAGE_LOG_FILE);
  if (stat.size <= USAGE_LOG_MAX_BYTES) return;

  const keepBytes = Math.max(1024, USAGE_LOG_MAX_BYTES);
  const file = await fs.promises.open(USAGE_LOG_FILE, "r");
  let text;
  try {
    const buffer = Buffer.alloc(Math.min(keepBytes, stat.size));
    await file.read(buffer, 0, buffer.length, stat.size - buffer.length);
    text = buffer.toString("utf8");
  } finally {
    await file.close();
  }

  text = completeJsonLines(text);
  await fs.promises.writeFile(USAGE_LOG_FILE, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await chmodPrivateFile(USAGE_LOG_FILE);
}

function completeJsonLines(text) {
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return "";

  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.slice(firstNewline + 1);
}

export async function usageReport({ maxEvents = 1000, project: requestedProject } = {}) {
  await usageWrite.catch(() => {});
  const eventLimit = normalizeEventLimit(maxEvents);
  const entries = await readUsageEntries(eventLimit);
  const currentProject = projectKey();
  const project = normalizeRequestedProject(requestedProject, currentProject);

  if (project === "all") {
    const report = summarizeUsage(entries, "all projects", entries.length, entries.length, { allProjects: true });
    return {
      text: formatUsageReport(report),
      meta: report,
    };
  }

  if (!project) {
    const report = summarizeUsage([], process.cwd(), entries.length, 0);
    report.ignoredProject = true;
    return {
      text: formatUsageReport(report),
      meta: report,
    };
  }

  const projectEntries = entries.filter((entry) => entry.project === project);
  const report = summarizeUsage(projectEntries, project, entries.length, projectEntries.length, { requestedProject: requestedProject ?? "current" });

  return {
    text: formatUsageReport(report),
    meta: report,
  };
}

function normalizeRequestedProject(requestedProject, currentProject) {
  if (requestedProject === undefined || requestedProject === null || requestedProject === "") return currentProject;
  if (requestedProject === "all") return "all";

  const value = String(requestedProject);
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved) || isPathLikeProjectFilter(value)) return projectKeyForPath(resolved);
  return value;
}

function isPathLikeProjectFilter(value) {
  return path.isAbsolute(value)
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\");
}

function normalizeEventLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1000;
  return Math.max(1, Math.min(Math.trunc(numeric), MAX_REPORT_EVENTS));
}

async function readUsageEntries(maxEvents) {
  let text;
  try {
    const stat = await fs.promises.stat(USAGE_LOG_FILE);
    if (stat.size > REPORT_READ_BYTES) {
      const file = await fs.promises.open(USAGE_LOG_FILE, "r");
      try {
        const buffer = Buffer.alloc(REPORT_READ_BYTES);
        await file.read(buffer, 0, REPORT_READ_BYTES, stat.size - REPORT_READ_BYTES);
        text = buffer.toString("utf8");
      } finally {
        await file.close();
      }
    } else {
      text = await fs.promises.readFile(USAGE_LOG_FILE, "utf8");
    }
  } catch {
    return [];
  }

  return text
    .split("\n")
    .filter(Boolean)
    .slice(-maxEvents)
    .map(parseUsageLine)
    .filter(Boolean);
}

function parseUsageLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed?.tool !== "string" || typeof parsed?.project !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function summarizeUsage(entries, project, eventsRead, projectEventsRead, options = {}) {
  const byTool = new Map();
  const byCommandKind = new Map();
  const byProject = new Map();
  const byFailure = new Map();
  let truncatedCalls = 0;
  let failedCalls = 0;

  for (const entry of entries) {
    if (entry.truncated) truncatedCalls++;
    if (entry.ok === false) {
      failedCalls++;
      addFailureSummary(byFailure, entry);
    }
    addSummary(byTool, entry.tool, entry);
    if (entry.commandKind) addSummary(byCommandKind, entry.commandKind, entry);
    if (entry.project) addSummary(byProject, entry.project, entry);
  }

  const toolSummaries = sortedSummaries(byTool);
  const commandSummaries = sortedSummaries(byCommandKind);
  const failureSummaries = sortedFailureSummaries(byFailure);

  return {
    project,
    logFile: USAGE_LOG_FILE,
    loggingEnabled: usageLogEnabled(),
    eventsRead,
    projectEventsRead,
    eventsAnalyzed: entries.length,
    truncatedCalls,
    failedCalls,
    allProjects: Boolean(options.allProjects),
    requestedProject: options.requestedProject,
    projectOverview: sortedSummaries(byProject),
    topReturnedByteCalls: topReturnedByteCalls(entries),
    topTruncationContributors: [...toolSummaries].sort((a, b) => b.truncated - a.truncated || b.returnedBytes - a.returnedBytes).filter((summary) => summary.truncated > 0).slice(0, 10),
    failureSummaries,
    byTool: toolSummaries,
    byCommandKind: commandSummaries,
    recommendations: recommendTools(commandSummaries, toolSummaries, failureSummaries),
  };
}

function addSummary(map, key, entry) {
  if (!key) return;
  const summary = map.get(key) ?? { name: key, calls: 0, truncated: 0, failed: 0, totalBytes: 0, returnedBytes: 0, savedBytes: 0, totalDurationMs: 0 };
  summary.calls++;
  if (entry.truncated) summary.truncated++;
  if (entry.ok === false) summary.failed++;
  summary.totalBytes += numberOrZero(entry.totalBytes);
  summary.returnedBytes += numberOrZero(entry.returnedBytes);
  summary.savedBytes += numberOrZero(entry.savedBytes);
  summary.totalDurationMs += numberOrZero(entry.durationMs);
  map.set(key, summary);
}

function sortedSummaries(map) {
  return [...map.values()]
    .map((summary) => ({
      ...summary,
      avgDurationMs: summary.calls > 0 ? Math.round(summary.totalDurationMs / summary.calls) : 0,
      savedPercent: summary.totalBytes > 0 ? Math.round((summary.savedBytes / summary.totalBytes) * 100) : 0,
    }))
    .sort((a, b) => b.truncated - a.truncated || b.calls - a.calls || b.savedBytes - a.savedBytes);
}

function addFailureSummary(map, entry) {
  const tool = entry.tool ?? "unknown";
  const exitCode = entry.exitCode ?? "none";
  const errorCode = entry.errorCode ?? "none";
  const key = `${tool}\t${exitCode}\t${errorCode}`;
  const summary = map.get(key) ?? { tool, exitCode, errorCode, calls: 0, returnedBytes: 0, commandKind: entry.commandKind };
  summary.calls++;
  summary.returnedBytes += numberOrZero(entry.returnedBytes);
  if (!summary.commandKind && entry.commandKind) summary.commandKind = entry.commandKind;
  map.set(key, summary);
}

function sortedFailureSummaries(map) {
  return [...map.values()].sort((a, b) => b.calls - a.calls || b.returnedBytes - a.returnedBytes);
}

function topReturnedByteCalls(entries) {
  return [...entries]
    .filter((entry) => numberOrZero(entry.returnedBytes) > 0)
    .sort((a, b) => numberOrZero(b.returnedBytes) - numberOrZero(a.returnedBytes))
    .slice(0, 10)
    .map((entry) => ({
      tool: entry.tool,
      project: entry.project,
      returnedBytes: numberOrZero(entry.returnedBytes),
      totalBytes: numberOrZero(entry.totalBytes),
      truncated: Boolean(entry.truncated),
      exitCode: entry.exitCode,
      errorCode: entry.errorCode,
      commandKind: entry.commandKind,
    }));
}

function recommendTools(commandSummaries, toolSummaries, failureSummaries = []) {
  const recommendations = [];
  const commandMap = new Map(commandSummaries.map((summary) => [summary.name, summary]));
  const toolMap = new Map(toolSummaries.map((summary) => [summary.name, summary]));

  addRecommendation(recommendations, commandMap.get("git-history"), "sc-diff mode=history", "Summarize git log output compactly without adding another tool.");
  addRecommendation(recommendations, commandMap.get("test-build"), "sc-logs", "Use bounded diagnostic blocks for tests, builds, lints, typechecks, publishes, and CI output.");
  addRecommendation(recommendations, commandMap.get("dependencies"), "sc-run", "Use bounded command output for dependency inspection.");
  addRecommendation(recommendations, commandMap.get("infra-logs"), "sc-logs", "Extract relevant docker/kubectl log blocks.");
  addRecommendation(recommendations, commandMap.get("filesystem-discovery"), "sc-discover", "Use files/tree modes for bounded repository discovery.");
  addRecommendation(recommendations, commandMap.get("file-read"), "sc-read path/fromLine/paths", "Use targeted ranges for one file and paths for additional non-ranged file previews.");

  const search = commandMap.get("search-discovery");
  const searchTool = toolMap.get("search");
  if (search && (!searchTool || search.calls > searchTool.calls)) {
    addRecommendation(recommendations, search, "sc-search", "Use bounded search results with contextLines when surrounding lines are useful.");
  }

  const searchRegexFailures = failureSummaries.find((summary) => (summary.tool === "search" || summary.tool === "sc-search" || summary.commandKind === "search-discovery") && summary.exitCode === 2);
  if (searchRegexFailures) {
    recommendations.push({
      toolName: "sc-search literal:true",
      reason: "Search exitCode 2 often means a regex parse error; use literal:true for plain strings or validate regex syntax.",
      evidence: `${searchRegexFailures.calls} search failures with exitCode 2`,
      calls: searchRegexFailures.calls,
      truncated: 0,
    });
  }

  return recommendations;
}

function addRecommendation(recommendations, summary, toolName, reason) {
  if (!summary) return;
  if (summary.calls < 3 && summary.truncated === 0) return;
  recommendations.push({
    toolName,
    reason,
    evidence: `${summary.calls} ${summary.name} commands, ${summary.truncated} truncated, ${summary.failed} failed`,
    calls: summary.calls,
    truncated: summary.truncated,
  });
}

function formatUsageReport(report) {
  if (report.eventsAnalyzed === 0) {
    const lines = [
      `Usage summary for ${report.project}`,
      `Log file: ${report.logFile}`,
    ];
    if (report.ignoredProject) lines.push("Current working directory is a markerless temp directory; usage is ignored.");
    else if (report.eventsRead > 0) lines.push("No usage events found for this project in the current window. Try increasing maxEvents or use project:\"all\" to inspect all logged projects.");
    else lines.push("No usage events found yet.");
    return lines.join("\n");
  }

  const lines = [
    `Usage summary for ${report.project}`,
    `Log file: ${report.logFile}`,
    report.allProjects
      ? `Events analyzed: ${report.eventsAnalyzed} (${report.projectEventsRead} across all projects, ${report.eventsRead} read)`
      : `Events analyzed: ${report.eventsAnalyzed} (${report.projectEventsRead} for this project, ${report.eventsRead} read)`,
    `Truncated calls: ${report.truncatedCalls}`,
    `Failed calls: ${report.failedCalls}`,
  ];

  if (report.allProjects && report.projectOverview.length > 0) {
    lines.push("", "Project overview:");
    for (const summary of report.projectOverview.slice(0, 10)) lines.push(formatSummaryLine(summary));
  }

  lines.push("", "By tool:");
  for (const summary of report.byTool.slice(0, 10)) lines.push(formatToolSummaryLine(summary));

  if (report.byCommandKind.length > 0) {
    lines.push("", "Command kinds:");
    for (const summary of report.byCommandKind.slice(0, 10)) lines.push(formatSummaryLine(summary));
  }

  if (report.topReturnedByteCalls.length > 0) {
    lines.push("", "Top returned-byte calls:");
    for (const call of report.topReturnedByteCalls.slice(0, 5)) lines.push(`${displayToolName(call.tool)}${call.commandKind ? `/${call.commandKind}` : ""}: ${formatBytes(call.returnedBytes)} returned${call.truncated ? ", truncated" : ""}${call.exitCode !== undefined ? `, exitCode ${call.exitCode}` : ""}`);
  }

  if (report.topTruncationContributors.length > 0) {
    lines.push("", "Top truncation contributors:");
    for (const summary of report.topTruncationContributors.slice(0, 5)) lines.push(`${displayToolName(summary.name)}: ${summary.truncated} truncated, ${formatBytes(summary.returnedBytes)} returned`);
  }

  if (report.failureSummaries.length > 0) {
    lines.push("", "Failures by tool/exitCode/errorCode:");
    for (const failure of report.failureSummaries.slice(0, 10)) lines.push(`${displayToolName(failure.tool)} exitCode=${failure.exitCode} errorCode=${failure.errorCode}: ${failure.calls} failed`);
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Suggested tools/modes:");
    for (const recommendation of report.recommendations.slice(0, 10)) {
      lines.push(`${recommendation.toolName}: ${recommendation.evidence} - ${recommendation.reason}`);
    }
  } else {
    lines.push("", "Suggested tools/modes:", "No strong candidates yet.");
  }

  return lines.join("\n");
}

function displayToolName(toolName) {
  return typeof toolName === "string" && !toolName.startsWith("sc-") ? `sc-${toolName}` : toolName;
}

function formatToolSummaryLine(summary) {
  return formatSummaryLine({ ...summary, name: displayToolName(summary.name) });
}

function formatSummaryLine(summary) {
  return `${summary.name}: ${summary.calls} calls, ${summary.truncated} truncated, ${summary.failed} failed, saved ${formatBytes(summary.savedBytes)} (${summary.savedPercent}%), avg ${summary.avgDurationMs}ms`;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "command") {
      summary.hasCommand = typeof value === "string" && value.length > 0;
    } else if (key === "paths") {
      summary[key] = Array.isArray(value) ? `array:${value.length}` : typeof value;
    } else if (["path", "url", "include", "pattern"].includes(key)) {
      summary[key] = typeof value;
    } else if (["maxLines", "maxBytes", "maxLinesPerFile", "maxBytesPerFile", "maxTotalBytes", "maxMatches", "maxFiles", "maxHunks", "maxBlocks", "contextLines"].includes(key)) {
      summary[key] = numberOrUndefined(value);
    } else if (typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary;
}

export function classifyCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const normalized = command.toLowerCase();

  if (/\bgit\s+(log|show|blame|reflog|shortlog)\b/.test(normalized)) return "git-history";
  if (/\bgit\s+(diff|status|stash|branch|remote)\b/.test(normalized)) return "git-review";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|build|typecheck|type-check)|check|lint|build|typecheck|type-check)\b/.test(normalized)) return "test-build";
  if (/\b(?:vite|next|nuxt|astro|ng|nx)\s+(?:test|build|lint|check)\b/.test(normalized)) return "test-build";
  if (/\b(?:tsc|vue-tsc|svelte-check|eslint|jest|vitest|playwright\s+test|cypress\s+run)\b/.test(normalized)) return "test-build";
  if (/\bdotnet\s+(?:test|build|publish|pack|format|msbuild|clean)\b/.test(normalized)) return "test-build";
  if (/\b(?:cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|pytest|python(?:3)?\s+-m\s+pytest|tox|ruff|mypy|pyright|mvnw?\s+(?:test|package|verify|install)|gradlew?\s+(?:test|build|check|lint|assemble\w*|bundle\w*|connected\w*|\S*test\S*|\S*lint\S*|\S*assemble\S*|\S*bundle\S*|\S*connected\S*))\b/.test(normalized)) return "test-build";
  if (/\b(?:xcodebuild\s+(?:test|build|archive|analyze)|swift\s+(?:test|build)|swiftlint|fastlane\b|make\s+(?:test|build|check|lint)|cmake\s+--build|ctest\b|ninja(?:\s|$))/.test(normalized)) return "test-build";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ls|list|why|outdated|audit|info|view|install|ci|add)\b/.test(normalized)) return "dependencies";
  if (/\bdotnet\s+(?:restore|list\s+package|add\s+\S+\s+package)\b|\bcargo\s+(?:add|update|tree)\b/.test(normalized)) return "dependencies";
  if (/\b(?:docker|kubectl)\s+logs\b|\bkubectl\s+(?:get|describe)\b|\badb\s+logcat\b|\bxcrun\s+simctl\b.*\blog\s+stream\b|\blog\s+stream\b/.test(normalized)) return "infra-logs";
  if (/\b(?:rg|grep|ag)\b/.test(normalized)) return "search-discovery";
  if (/\b(?:find|fd|tree|du|ls)\b/.test(normalized)) return "filesystem-discovery";
  if (/\b(?:cat|type|get-content)\b/.test(normalized)) return "file-read";
  return "other";
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
