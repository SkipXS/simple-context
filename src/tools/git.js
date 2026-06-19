import { DEFAULT_BYTES, MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { runProcess, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { formatTruncationReason, invalidParams, omission, savingsForText, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

const GIT_TIMEOUT_MS = 30_000;

export async function gitTool(args) {
  const {
    mode = "overview",
    maxFiles = 20,
    maxCommits = 20,
    maxLines = MAX_LINES,
    maxBytes = DEFAULT_BYTES,
  } = args ?? {};

  if (mode !== "overview" && mode !== "precommit" && mode !== "history") invalidParams("git mode must be \"overview\", \"precommit\", or \"history\"");
  const fileLimit = validateInteger(maxFiles, "git maxFiles", 1, 100);
  const commitLimit = validateInteger(maxCommits, "git maxCommits", 1, 100);
  const lineLimit = validateInteger(maxLines, "git maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "git maxBytes", 1024, MAX_BYTES);

  const repository = await repositoryInfo();
  if (!repository.gitRepository) return await notGitRepositoryResult(mode, lineLimit, byteLimit);

  if (mode === "history") return await historyTool(commitLimit, lineLimit, byteLimit);
  if (mode === "precommit") return await precommitTool(fileLimit, lineLimit, byteLimit, repository);
  return await overviewTool(fileLimit, lineLimit, byteLimit, repository);
}

async function overviewTool(maxFiles, maxLines, maxBytes, repository) {
  const started = Date.now();
  const [status, untracked, unstagedStat, stagedStat] = await Promise.all([
    runGit(["status", "--short", "--branch", "--untracked-files=no"]),
    listUntracked(maxFiles),
    runGit(["diff", "--stat", `--stat-count=${maxFiles}`]),
    runGit(["diff", "--cached", "--stat", `--stat-count=${maxFiles}`]),
  ]);

  const text = joinSections([
    ["Branch:", formatBranchSummary(repository, status.stdout)],
    ["Status:", status.stdout.trimEnd() || "(clean)"],
    ["Untracked files:", formatUntracked(untracked)],
    ["Unstaged diffstat:", unstagedStat.stdout.trimEnd() || "(no unstaged changes)"],
    ["Staged diffstat:", stagedStat.stdout.trimEnd() || "(no staged changes)"],
  ]);

  return await boundedResult("overview", text, maxLines, maxBytes, {
    maxFiles,
    gitRepository: true,
    branch: repository.branch,
    upstream: repository.upstream,
    untrackedShown: untracked.shown,
    untrackedLimited: untracked.limited,
    durationMs: Date.now() - started,
  });
}

async function precommitTool(maxFiles, maxLines, maxBytes, repository) {
  const started = Date.now();
  const [statusResult, untracked, unstagedStat, stagedStat] = await Promise.all([
    runGit(["status", "--porcelain=v1", "--untracked-files=no"]),
    listUntracked(maxFiles),
    runGit(["diff", "--stat", `--stat-count=${maxFiles}`]),
    runGit(["diff", "--cached", "--stat", `--stat-count=${maxFiles}`]),
  ]);
  const counts = statusCounts(statusResult.stdout);
  counts.untracked = untracked.shown;

  const unstagedCheck = counts.unstaged > 0 ? await runGitCheck(["diff", "--check"]) : checkSkipped("no unstaged changes");
  const stagedCheck = counts.staged > 0 ? await runGitCheck(["diff", "--cached", "--check"]) : checkSkipped("no staged changes");
  const warning = counts.staged === 0 ? "Warning: nothing staged for commit." : "";

  const text = joinSections([
    ["Precommit readiness:", [
      `Branch: ${repository.branch ?? "(detached or unknown)"}`,
      `Staged files: ${counts.staged}`,
      `Unstaged files: ${counts.unstaged}`,
      `Untracked files: ${counts.untracked}${untracked.limited ? "+" : ""}`,
      warning,
    ].filter(Boolean).join("\n")],
    ["Status:", formatStatusLines(statusResult.stdout) || "(clean)"],
    ["Whitespace checks:", formatChecks(unstagedCheck, stagedCheck)],
    ["Staged diffstat:", stagedStat.stdout.trimEnd() || "(no staged changes)"],
    ["Unstaged diffstat:", unstagedStat.stdout.trimEnd() || "(no unstaged changes)"],
  ]);

  return await boundedResult("precommit", text, maxLines, maxBytes, {
    maxFiles,
    gitRepository: true,
    branch: repository.branch,
    stagedFiles: counts.staged,
    unstagedFiles: counts.unstaged,
    untrackedFiles: counts.untracked,
    untrackedLimited: untracked.limited,
    stagedCheckOk: stagedCheck.ok,
    unstagedCheckOk: unstagedCheck.ok,
    nothingStaged: counts.staged === 0,
    durationMs: Date.now() - started,
  });
}

async function historyTool(maxCommits, maxLines, maxBytes) {
  const started = Date.now();
  const result = await runGit(["log", `--max-count=${maxCommits}`, "--oneline", "--decorate"]);
  const raw = result.stdout.trimEnd();
  const noHistory = result.code !== 0 && /does not have any commits|your current branch .* does not have any commits/i.test(result.stderr);
  if (result.code !== 0 && !noHistory) throwGitError("git log", result);

  const text = raw ? `Recent history:\n${raw}` : "(no commit history)";
  return await boundedResult("history", text, maxLines, maxBytes, {
    maxCommits,
    gitRepository: true,
    commitsShown: raw ? raw.split("\n").filter(Boolean).length : 0,
    empty: raw === "",
    emptyReason: raw === "" ? "no_commit_history" : undefined,
    durationMs: Date.now() - started,
  });
}

async function repositoryInfo() {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { gitRepository: false };

  const [branchResult, upstreamResult] = await Promise.all([
    runGit(["branch", "--show-current"]),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  return {
    gitRepository: true,
    branch: branchResult.stdout.trim() || undefined,
    upstream: upstreamResult.code === 0 ? upstreamResult.stdout.trim() || undefined : undefined,
  };
}

async function listUntracked(maxFiles) {
  const result = await runProcessLines("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: process.cwd(),
    timeout: GIT_TIMEOUT_MS,
    maxLines: maxFiles + 1,
    maxBytes: 64 * 1024,
  });
  if (result.code !== 0 && !result.truncated && !result.outputTooLarge) throwGitError("git ls-files", result);

  const limited = result.truncated || result.lines.length > maxFiles;
  return {
    names: result.lines.slice(0, maxFiles),
    shown: Math.min(result.lines.length, maxFiles),
    limited,
  };
}

async function runGitCheck(args) {
  const result = await runGit(args);
  return {
    ok: result.code === 0,
    text: (result.stdout || result.stderr).trimEnd(),
  };
}

function checkSkipped(reason) {
  return { ok: true, skipped: true, text: `(skipped: ${reason})` };
}

async function runGit(args) {
  return await runProcess("git", args, { cwd: process.cwd(), timeout: GIT_TIMEOUT_MS });
}

function throwGitError(command, result) {
  const message = (result.stderr || result.stdout || `${command} failed`).trim();
  const error = new Error(message);
  error.code = result.code;
  throw error;
}

function formatBranchSummary(repository, statusText) {
  const statusBranchLine = statusText.split("\n").find((line) => line.startsWith("## "));
  const lines = [`Current: ${repository.branch ?? "(detached or unknown)"}`];
  if (repository.upstream) lines.push(`Upstream: ${repository.upstream}`);
  if (statusBranchLine) lines.push(`Status: ${statusBranchLine.slice(3)}`);
  return lines.join("\n");
}

function formatUntracked(untracked) {
  if (untracked.names.length === 0) return "(none)";
  const header = `Showing ${untracked.names.length}${untracked.limited ? "+" : ""}:`;
  const marker = untracked.limited ? [omission("untracked files")] : [];
  return [header, ...untracked.names, ...marker].join("\n");
}

function statusCounts(statusText) {
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  for (const line of statusText.split("\n").filter(Boolean)) {
    if (line.startsWith("??")) {
      counts.untracked++;
      continue;
    }
    if (line[0] && line[0] !== " ") counts.staged++;
    if (line[1] && line[1] !== " ") counts.unstaged++;
  }
  return counts;
}

function formatStatusLines(statusText) {
  return statusText.split("\n").filter(Boolean).map((line) => `${line.slice(0, 2)} ${line.slice(3)}`).join("\n");
}

function formatChecks(unstagedCheck, stagedCheck) {
  return [
    `Unstaged: ${unstagedCheck.ok ? "ok" : "issues found"}`,
    unstagedCheck.text,
    `Staged: ${stagedCheck.ok ? "ok" : "issues found"}`,
    stagedCheck.text,
  ].filter(Boolean).join("\n");
}

function joinSections(sections) {
  return sections
    .filter(([, body]) => body !== undefined && body !== "")
    .map(([title, body]) => `${title}\n${body}`)
    .join("\n\n");
}

async function boundedResult(mode, text, maxLines, maxBytes, extraMeta = {}) {
  const formatted = formatOutput(text, maxLines, maxBytes);
  const outputSavings = savingsForText(text, formatted.text);
  const truncated = formatted.truncated || Boolean(extraMeta.untrackedLimited);
  const meta = withResponseMeta({
    mode,
    ...extraMeta,
    totalLines: text.split("\n").length,
    totalBytes: outputSavings.totalBytes,
    totalBytesKnown: !truncated,
    ...outputSavings,
    truncated,
    ...truncationMeta(truncated, extraMeta.untrackedLimited ? "max_files" : formatTruncationReason(formatted, maxLines, maxBytes), extraMeta.untrackedLimited ? "Increase maxFiles." : "Increase maxLines/maxBytes."),
  });
  await recordStats("git", meta);
  return toolTextResult(formatted.text, meta, maxBytes);
}

async function notGitRepositoryResult(mode, maxLines, maxBytes) {
  const text = "(not a git repository; run sc-git from inside a Git work tree)";
  return await boundedResult(mode, text, maxLines, maxBytes, {
    gitRepository: false,
    empty: true,
    emptyReason: "not_git_repository",
    durationMs: 0,
  });
}
