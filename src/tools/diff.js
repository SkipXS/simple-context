import { StringDecoder } from "node:string_decoder";
import { DEFAULT_BYTES, MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { commandError, runProcess, spawnTrackedProcess, terminateChild } from "../process.js";
import { recordStats } from "../stats.js";
import { assertPathAllowed, formatTruncationReason, invalidParams, omission, relativePath, savingsForText, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

export async function diffTool(args) {
  const {
    path: diffPath,
    mode = "diff",
    staged = false,
    stat = true,
    maxFiles = 20,
    maxCommits,
    maxHunks = 20,
    maxLines = MAX_LINES,
    maxBytes = DEFAULT_BYTES,
  } = args ?? {};

  let normalizedDiffPath = diffPath;
  if (diffPath !== undefined) {
    if (typeof diffPath !== "string") invalidParams("diff path must be a string when provided");
    if (diffPath.trim() === "") normalizedDiffPath = undefined;
  }
  if (mode !== "diff" && mode !== "status" && mode !== "history" && mode !== "files" && mode !== "summary") invalidParams("diff mode must be \"diff\", \"status\", \"history\", \"files\", or \"summary\"");
  if (typeof staged !== "boolean") {
    invalidParams("diff staged must be a boolean when provided");
  }
  if (typeof stat !== "boolean") {
    invalidParams("diff stat must be a boolean when provided");
  }

  const fileLimit = validateInteger(maxFiles, "diff maxFiles", 1, 100);
  const commitLimit = maxCommits === undefined ? fileLimit : validateInteger(maxCommits, "diff maxCommits", 1, 100);
  const hunkLimit = validateInteger(maxHunks, "diff maxHunks", 1, 200);
  const lineLimit = validateInteger(maxLines, "diff maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "diff maxBytes", 1024, MAX_BYTES);
  await assertPathAllowed(normalizedDiffPath ?? process.cwd(), "diff");

  try {
    if (mode === "status") return await statusTool(normalizedDiffPath, staged, lineLimit, byteLimit);
    if (mode === "history") return await historyTool(normalizedDiffPath, commitLimit, lineLimit, byteLimit);
    if (mode === "files") return await filesTool(normalizedDiffPath, staged, fileLimit, lineLimit, byteLimit);
    if (mode === "summary") return await summaryTool(normalizedDiffPath, staged, stat, fileLimit, hunkLimit, lineLimit, byteLimit);

    const started = Date.now();
    const namesResult = await runGitNamePreview(gitDiffArgs(staged, ["--name-only"], normalizedDiffPath), fileLimit + 1);
  const selectedPaths = namesResult.paths.slice(0, fileLimit);
  const filesLimited = namesResult.limited || namesResult.paths.length > fileLimit;
  const statPromise = stat ? runGit(gitDiffArgs(staged, ["--stat", `--stat-count=${fileLimit}`], normalizedDiffPath)) : undefined;
  const previewLineLimit = diffPreviewLineLimit(lineLimit);
  const previewByteLimit = diffPreviewByteLimit(byteLimit);
  const diffPromise = selectedPaths.length > 0
    ? runGitDiffPreview(gitDiffArgs(staged, [], selectedPaths), hunkLimit, previewLineLimit, previewByteLimit)
    : Promise.resolve({ text: "", filesShown: 0, hunksShown: 0, hunksLimited: false, outputLimited: false });
  const [statResult, limitedDiff] = await Promise.all([statPromise, diffPromise]);
  const durationMs = Date.now() - started;

  const statText = statResult?.stdout.trimEnd() ?? "";
  const limitedDiffText = filesLimited && limitedDiff.text
    ? `${limitedDiff.text}\n${omission("files")}`
    : limitedDiff.text;
  const previewText = composeDiffText(statText, limitedDiffText);
  const formatted = formatOutput(previewText, lineLimit, byteLimit);
  const previewSavings = savingsForText(previewText, formatted.text);
  const truncated = filesLimited || limitedDiff.hunksLimited || limitedDiff.outputLimited || formatted.truncated;
  const totalBytesKnown = !truncated;
  const meta = withResponseMeta({
    totalLines: previewText.split("\n").length,
    totalBytes: previewSavings.totalBytes,
    totalBytesKnown,
    ...previewSavings,
    truncated,
    ...truncationMeta(truncated, diffTruncationReason({ ...limitedDiff, filesLimited }, formatted, lineLimit, byteLimit), diffTruncationHint({ ...limitedDiff, filesLimited }, formatted, lineLimit, byteLimit)),
    mode,
    path: normalizedDiffPath,
    relativePath: normalizedDiffPath === undefined ? undefined : relativePath(normalizedDiffPath),
    staged,
    stat,
    filesChanged: namesResult.paths.length,
    filesChangedKnown: !filesLimited,
    filesShown: limitedDiff.filesShown,
    filesLimited,
    hunksChanged: limitedDiff.hunksShown,
    hunksChangedKnown: !limitedDiff.hunksLimited && !limitedDiff.outputLimited,
    hunksShown: limitedDiff.hunksShown,
    hunksLimited: limitedDiff.hunksLimited,
    empty: previewText === "(no diff)",
    emptyReason: previewText === "(no diff)" ? "no_diff" : undefined,
    durationMs,
  });
    await recordStats("diff", meta);

    return toolTextResult(formatted.text, meta, byteLimit);
  } catch (error) {
    if (isNotGitRepositoryError(error)) return await notGitRepositoryResult(mode, normalizedDiffPath, staged, stat, byteLimit);
    throw error;
  }
}

async function filesTool(diffPath, staged, maxFiles, maxLines, maxBytes) {
  const started = Date.now();
  const namesResult = await runGitNamePreview(gitDiffArgs(staged, ["--name-only"], diffPath), maxFiles + 1);
  const shownPaths = namesResult.paths.slice(0, maxFiles);
  const filesLimited = namesResult.limited || namesResult.paths.length > maxFiles;
  const text = shownPaths.length > 0
    ? `Changed files:\n${shownPaths.join("\n")}${filesLimited ? `\n${omission("files")}` : ""}`
    : "(no tracked changed files; untracked files excluded)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const fileSavings = savingsForText(text, formatted.text);
  const truncated = filesLimited || formatted.truncated;
  const meta = withResponseMeta({
    mode: "files",
    path: diffPath,
    relativePath: diffPath === undefined ? undefined : relativePath(diffPath),
    staged,
    filesChanged: namesResult.paths.length,
    filesChangedKnown: !filesLimited,
    filesShown: shownPaths.length,
    filesLimited,
    totalLines: text.split("\n").length,
    totalBytes: fileSavings.totalBytes,
    totalBytesKnown: !truncated,
    ...fileSavings,
    truncated,
    ...truncationMeta(truncated, filesLimited ? "max_files" : formatTruncationReason(formatted, maxLines, maxBytes), filesLimited ? "Increase maxFiles or pass a narrower path." : "Increase maxLines/maxBytes or pass a narrower path."),
    empty: shownPaths.length === 0,
    emptyReason: shownPaths.length === 0 ? "no_tracked_changed_files" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("diff", meta);

  return toolTextResult(formatted.text, meta, maxBytes);
}

async function summaryTool(diffPath, staged, stat, maxFiles, maxHunks, maxLines, maxBytes) {
  const started = Date.now();
  const namesResult = await runGitNamePreview(gitDiffArgs(staged, ["--name-only"], diffPath), maxFiles + 1);
  const selectedPaths = namesResult.paths.slice(0, maxFiles);
  const filesLimited = namesResult.limited || namesResult.paths.length > maxFiles;
  const statPromise = stat ? runGit(gitDiffArgs(staged, ["--stat", `--stat-count=${maxFiles}`], diffPath)) : undefined;
  const headerPromise = selectedPaths.length > 0
    ? runGitDiffSummaryPreview(gitDiffArgs(staged, [], selectedPaths), maxHunks, diffPreviewLineLimit(maxLines), diffPreviewByteLimit(maxBytes))
    : Promise.resolve({ text: "", filesShown: 0, hunksShown: 0, hunksLimited: false, outputLimited: false });
  const [statResult, headerResult] = await Promise.all([statPromise, headerPromise]);
  const statText = statResult?.stdout.trimEnd() ?? "";
  const fileText = selectedPaths.length > 0 ? selectedPaths.join("\n") : "";
  const headersText = filesLimited && headerResult.text ? `${headerResult.text}\n${omission("files")}` : headerResult.text;
  const text = composeSummaryText(fileText, statText, headersText);
  const formatted = formatOutput(text, maxLines, maxBytes);
  const summarySavings = savingsForText(text, formatted.text);
  const truncated = filesLimited || headerResult.hunksLimited || headerResult.outputLimited || formatted.truncated;
  const meta = withResponseMeta({
    mode: "summary",
    path: diffPath,
    relativePath: diffPath === undefined ? undefined : relativePath(diffPath),
    staged,
    stat,
    filesChanged: namesResult.paths.length,
    filesChangedKnown: !filesLimited,
    filesShown: selectedPaths.length,
    filesLimited,
    hunksChanged: headerResult.hunksShown,
    hunksChangedKnown: !headerResult.hunksLimited && !headerResult.outputLimited,
    hunksShown: headerResult.hunksShown,
    hunksLimited: headerResult.hunksLimited,
    totalLines: text.split("\n").length,
    totalBytes: summarySavings.totalBytes,
    totalBytesKnown: !truncated,
    ...summarySavings,
    truncated,
    ...truncationMeta(truncated, diffTruncationReason({ ...headerResult, filesLimited }, formatted, maxLines, maxBytes), diffTruncationHint({ ...headerResult, filesLimited }, formatted, maxLines, maxBytes)),
    empty: text === "(no diff)",
    emptyReason: text === "(no diff)" ? "no_diff" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("diff", meta);

  return toolTextResult(formatted.text, meta, maxBytes);
}

async function historyTool(diffPath, maxCommits, maxLines, maxBytes) {
  const started = Date.now();
  const args = [
    "log",
    `--max-count=${maxCommits}`,
    "--date=short",
    "--pretty=format:commit %h%nDate: %ad%nAuthor: %an%nSubject: %s",
    "--name-status",
  ];
  if (diffPath !== undefined) args.push("--", diffPath);
  const result = await runGit(args);
  const raw = result.stdout.trimEnd();
  const text = raw ? `Commit history:\n${raw}` : "(no commit history)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const historySavings = savingsForText(text, formatted.text);
  const meta = withResponseMeta({
    mode: "history",
    path: diffPath,
    relativePath: diffPath === undefined ? undefined : relativePath(diffPath),
    maxCommits,
    commitsShown: countHistoryCommits(raw),
    totalLines: text.split("\n").length,
    totalBytes: historySavings.totalBytes,
    ...historySavings,
    truncated: formatted.truncated,
    ...truncationMeta(formatted.truncated, formatTruncationReason(formatted, maxLines, maxBytes), "Increase maxLines/maxBytes."),
    empty: raw === "",
    emptyReason: raw === "" ? "no_commit_history" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("diff", meta);

  return toolTextResult(formatted.text, meta, maxBytes);
}

async function statusTool(diffPath, staged, maxLines, maxBytes) {
  const started = Date.now();
  const args = ["status", "--porcelain=v1", "--untracked-files=no"];
  if (diffPath !== undefined) args.push("--", diffPath);
  const result = await runProcess("git", args, { cwd: process.cwd(), timeout: 30_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) {
    commandError(`git ${args.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge, 30_000);
  }

  const lines = result.stdout.trimEnd().split("\n").filter(Boolean)
    .filter((line) => staged ? line[0] !== " " : line[1] !== " ")
    .map(formatStatusLine);
  const text = lines.join("\n") || "(no tracked changed files; untracked files excluded)";
  const formatted = formatOutput(text, maxLines, maxBytes);
  const meta = withResponseMeta({
    mode: "status",
    path: diffPath,
    relativePath: diffPath === undefined ? undefined : relativePath(diffPath),
    staged,
    changedFiles: lines.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    savedPercent: formatted.savedPercent,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
    truncated: formatted.truncated,
    ...truncationMeta(formatted.truncated, formatTruncationReason(formatted, maxLines, maxBytes), "Increase maxLines/maxBytes."),
    empty: lines.length === 0,
    emptyReason: lines.length === 0 ? "no_tracked_changed_files" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("diff", meta);

  return toolTextResult(formatted.text, meta, maxBytes);
}

function formatStatusLine(line) {
  return `${line.slice(0, 2)} ${line.slice(3)}`;
}

function gitDiffArgs(staged, extraArgs, diffPath) {
  const args = ["diff"];
  if (staged) args.push("--cached");
  args.push(...extraArgs);
  if (Array.isArray(diffPath)) {
    if (diffPath.length > 0) args.push("--", ...diffPath);
  } else if (diffPath !== undefined) {
    args.push("--", diffPath);
  }
  return args;
}

async function runGit(args) {
  const result = await runProcess("git", args, { cwd: process.cwd(), timeout: 120_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) {
    commandError(`git ${args.join(" ")}`, result.code, result.signal, result.stdout, result.stderr, result.timedOut, result.outputTooLarge);
  }

  return result;
}

async function runGitNamePreview(args, maxNames) {
  return await new Promise((resolve, reject) => {
    const child = spawnTrackedProcess("git", args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const decoder = new StringDecoder("utf8");
    const stderr = [];
    const paths = [];
    let pendingLine = "";
    let limited = false;
    let timedOut = false;
    let stoppedEarly = false;
    let stopPromise = Promise.resolve();

    function stopEarly() {
      if (stoppedEarly) return;
      stoppedEarly = true;
      stopPromise = terminateChild(child);
    }

    function handleLine(line) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalized) return true;
      if (paths.length >= maxNames) {
        limited = true;
        stopEarly();
        return false;
      }

      paths.push(normalized);
      if (paths.length >= maxNames) {
        limited = true;
        stopEarly();
        return false;
      }
      return true;
    }

    child.stdout.on("data", (chunk) => {
      if (stoppedEarly) return;
      pendingLine += decoder.write(chunk);
      for (;;) {
        const newline = pendingLine.indexOf("\n");
        if (newline === -1) break;
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        if (!handleLine(line)) break;
      }
    });

    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      stopEarly();
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await stopPromise.catch(() => {});
      if (!stoppedEarly) {
        pendingLine += decoder.end();
        if (pendingLine) handleLine(pendingLine);
      }
      if ((code !== 0 || timedOut) && !stoppedEarly) {
        try {
          commandError(`git ${args.join(" ")}`, code, signal, paths.join("\n"), Buffer.concat(stderr).toString("utf8"), timedOut, false);
        } catch (error) {
          reject(error);
          return;
        }
      }
      resolve({ paths, limited });
    });
  });
}

async function runGitDiffSummaryPreview(args, maxHunks, maxOutputLines, maxOutputBytes) {
  return await new Promise((resolve, reject) => {
    const child = spawnTrackedProcess("git", args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const decoder = new StringDecoder("utf8");
    const stderr = [];
    const output = [];
    let pendingLine = "";
    let filesShown = 0;
    let hunksShown = 0;
    let hunksLimited = false;
    let outputLimited = false;
    let outputBytes = 0;
    let timedOut = false;
    let stoppedEarly = false;
    let stopPromise = Promise.resolve();

    function stopEarly() {
      if (stoppedEarly) return;
      stoppedEarly = true;
      stopPromise = terminateChild(child);
    }

    function pushOutput(line) {
      const separatorBytes = output.length > 0 ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (output.length >= maxOutputLines || outputBytes + separatorBytes + lineBytes > maxOutputBytes) return false;
      output.push(line);
      outputBytes += separatorBytes + lineBytes;
      return true;
    }

    function appendLimitMarker(kind) {
      const marker = omission(kind);
      if (output.at(-1) !== marker) pushOutput(marker);
    }

    function shouldKeepSummaryLine(line) {
      return line.startsWith("diff --git ")
        || line.startsWith("index ")
        || line.startsWith("new file mode ")
        || line.startsWith("deleted file mode ")
        || line.startsWith("similarity index ")
        || line.startsWith("rename from ")
        || line.startsWith("rename to ")
        || line.startsWith("--- ")
        || line.startsWith("+++ ")
        || line.startsWith("@@ ");
    }

    function handleLine(line) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (normalized.startsWith("diff --git ")) filesShown++;
      if (normalized.startsWith("@@ ")) {
        if (hunksShown >= maxHunks) {
          hunksLimited = true;
          appendLimitMarker("hunks");
          stopEarly();
          return false;
        }
        hunksShown++;
      }
      if (!shouldKeepSummaryLine(normalized)) return true;

      if (!pushOutput(normalized)) {
        outputLimited = true;
        appendLimitMarker("diff summary");
        stopEarly();
        return false;
      }
      return true;
    }

    child.stdout.on("data", (chunk) => {
      if (stoppedEarly) return;
      pendingLine += decoder.write(chunk);
      for (;;) {
        const newline = pendingLine.indexOf("\n");
        if (newline === -1) break;
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        if (!handleLine(line)) break;
      }
    });

    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      stopEarly();
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await stopPromise.catch(() => {});
      if (!stoppedEarly) {
        pendingLine += decoder.end();
        if (pendingLine) handleLine(pendingLine);
      }
      if ((code !== 0 || timedOut) && !stoppedEarly) {
        try {
          commandError(`git ${args.join(" ")}`, code, signal, output.join("\n"), Buffer.concat(stderr).toString("utf8"), timedOut, false);
        } catch (error) {
          reject(error);
          return;
        }
      }
      resolve({
        text: output.join("\n").trimEnd(),
        filesShown,
        hunksShown,
        hunksLimited,
        outputLimited,
      });
    });
  });
}

async function runGitDiffPreview(args, maxHunks, maxOutputLines, maxOutputBytes) {
  return await new Promise((resolve, reject) => {
    const child = spawnTrackedProcess("git", args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const decoder = new StringDecoder("utf8");
    const stderr = [];
    const output = [];
    let pendingLine = "";
    let filesShown = 0;
    let hunksShown = 0;
    let hunksLimited = false;
    let outputLimited = false;
    let outputBytes = 0;
    let timedOut = false;
    let stoppedEarly = false;
    let stopPromise = Promise.resolve();

    function stopEarly() {
      if (stoppedEarly) return;
      stoppedEarly = true;
      stopPromise = terminateChild(child);
    }

    function pushOutput(line) {
      const separatorBytes = output.length > 0 ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (output.length >= maxOutputLines || outputBytes + separatorBytes + lineBytes > maxOutputBytes) return false;
      output.push(line);
      outputBytes += separatorBytes + lineBytes;
      return true;
    }

    function appendLimitMarker(kind) {
      const marker = omission(kind);
      if (output.at(-1) !== marker) pushOutput(marker);
    }

    function handleLine(line) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (normalized.startsWith("diff --git ")) filesShown++;
      if (normalized.startsWith("@@ ")) {
        if (hunksShown >= maxHunks) {
          hunksLimited = true;
          appendLimitMarker("hunks");
          stopEarly();
          return false;
        }
        hunksShown++;
      }

      if (!pushOutput(normalized)) {
        outputLimited = true;
        appendLimitMarker("diff output");
        stopEarly();
        return false;
      }
      return true;
    }

    child.stdout.on("data", (chunk) => {
      if (stoppedEarly) return;
      pendingLine += decoder.write(chunk);
      for (;;) {
        const newline = pendingLine.indexOf("\n");
        if (newline === -1) break;
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        if (!handleLine(line)) break;
      }
    });

    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      stopEarly();
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await stopPromise.catch(() => {});
      if (!stoppedEarly) {
        pendingLine += decoder.end();
        if (pendingLine) handleLine(pendingLine);
      }
      if ((code !== 0 || timedOut) && !stoppedEarly) {
        try {
          commandError(`git ${args.join(" ")}`, code, signal, output.join("\n"), Buffer.concat(stderr).toString("utf8"), timedOut, false);
        } catch (error) {
          reject(error);
          return;
        }
      }
      resolve({
        text: output.join("\n").trimEnd(),
        filesShown,
        hunksShown,
        hunksLimited,
        outputLimited,
      });
    });
  });
}

function diffPreviewLineLimit(lineLimit) {
  return Math.min(500, Math.max(lineLimit * 6, lineLimit + 50));
}

function diffPreviewByteLimit(byteLimit) {
  return Math.min(MAX_BYTES, Math.max(byteLimit * 4, byteLimit + 4096));
}

function composeDiffText(statText, diffText) {
  const parts = [];
  if (statText) parts.push("Diff stat:", statText);
  if (diffText) {
    if (parts.length > 0) parts.push("");
    parts.push("Diff hunks:", diffText);
  }

  return parts.length > 0 ? parts.join("\n") : "(no diff)";
}

function composeSummaryText(fileText, statText, headersText) {
  const parts = [];
  if (fileText) parts.push("Changed files:", fileText);
  if (statText) {
    if (parts.length > 0) parts.push("");
    parts.push("Diff stat:", statText);
  }
  if (headersText) {
    if (parts.length > 0) parts.push("");
    parts.push("Diff headers:", headersText);
  }

  return parts.length > 0 ? parts.join("\n") : "(no diff)";
}

function isNotGitRepositoryError(error) {
  if (!error || error.timedOut || error.outputTooLarge) return false;
  const diagnostic = `${error.stderr ?? ""}\n${error.stdout ?? ""}`.toLowerCase();
  return diagnostic.includes("not a git repository") || diagnostic.includes("not in a git directory");
}

async function notGitRepositoryResult(mode, diffPath, staged, stat, maxBytes) {
  const text = "(not a git repository; run sc-diff from inside a Git work tree)";
  const meta = withResponseMeta({
    mode,
    path: diffPath,
    relativePath: diffPath === undefined ? undefined : relativePath(diffPath),
    staged,
    stat,
    totalLines: 1,
    totalBytes: Buffer.byteLength(text, "utf8"),
    returnedBytes: Buffer.byteLength(text, "utf8"),
    savedBytes: 0,
    savedPercent: 0,
    estimatedTokensSaved: 0,
    truncated: false,
    empty: true,
    emptyReason: "not_git_repository",
    gitRepository: false,
    durationMs: 0,
  });
  await recordStats("diff", meta);

  return toolTextResult(text, meta, maxBytes);
}

function countHistoryCommits(historyText) {
  return historyText ? historyText.split("\n").filter((line) => line.startsWith("commit ")).length : 0;
}

function diffTruncationReason(limitedDiff, formatted, maxLines, maxBytes) {
  if (limitedDiff.filesLimited) return "max_files";
  if (limitedDiff.hunksLimited) return "max_hunks";
  if (limitedDiff.outputLimited) return "format_limit";
  return formatTruncationReason(formatted, maxLines, maxBytes);
}

function diffTruncationHint(limitedDiff, formatted, maxLines, maxBytes) {
  if (limitedDiff.filesLimited) return "Increase maxFiles or pass a narrower path.";
  if (limitedDiff.hunksLimited) return "Increase maxHunks or pass a narrower path.";
  if (limitedDiff.outputLimited || formatted.truncated) return "Increase maxLines/maxBytes or pass a narrower path.";
  return undefined;
}
