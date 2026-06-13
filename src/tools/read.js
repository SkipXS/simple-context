import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_BYTES, MAX_BYTES, MAX_LINES, MAX_READ_BYTES, READ_RANGE_TIMEOUT_MS } from "../constants.js";
import { decodeUtf8, formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { assertPathAllowed, formatTruncationReason, invalidParams, omission, omitUndefined, relativePath, savingsForText, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

const READ_MANY_CONCURRENCY = 4;

export async function readTool(args) {
  const options = args ?? {};
  if (options.path === undefined && options.paths === undefined && options.ranges === undefined) {
    invalidParams("read requires path, paths, or ranges");
  }
  if (options.ranges !== undefined) {
    return await readRangesTool(options, "read");
  }
  if (options.paths !== undefined) {
    return await readManyTool({ ...options, paths: normalizeReadPaths(options) }, "read");
  }

  const result = await readFilePreview(options, "read");
  await recordStats("read", result._meta);

  return result;
}

function normalizeReadPaths(args) {
  const merged = [];
  if ((args ?? {}).path !== undefined) merged.push(args.path);
  if (Array.isArray(args.paths)) merged.push(...args.paths);
  else invalidParams("read requires paths to be an array when provided");

  const paths = [];
  const seen = new Set();
  for (const filePath of merged) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      invalidParams("read paths must contain non-empty strings");
    }
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

export async function readManyTool(args, toolName = "read") {
  const {
    path: primaryPath,
    paths,
    maxLines,
    maxBytes,
    maxLinesPerFile = maxLines ?? MAX_LINES,
    maxBytesPerFile = maxBytes ?? DEFAULT_BYTES,
    maxTotalLines = 200,
    maxTotalBytes = DEFAULT_BYTES,
    fromLine,
    toLine,
    lineNumbers = false,
  } = args ?? {};
  if (!Array.isArray(paths) || paths.length === 0) {
    invalidParams(`${toolName} requires a non-empty paths array`);
  }
  if (paths.length > 20) {
    invalidParams(`${toolName} paths must contain at most 20 files`);
  }
  if (typeof lineNumbers !== "boolean") invalidParams(`${toolName} lineNumbers must be a boolean when provided`);
  const rangeMode = fromLine !== undefined || toLine !== undefined;
  let rangePath;
  if (rangeMode) {
    if (typeof primaryPath === "string" && primaryPath.trim() !== "") rangePath = primaryPath;
    else if (paths.length === 1) rangePath = paths[0];
    else {
      invalidParams(`${toolName} range reads with multiple files require path to identify the ranged file; use path with fromLine/toLine and paths for additional files`);
    }
    normalizeLineRange(fromLine, toLine);
  }

  const lineLimit = validateInteger(maxLinesPerFile, `${toolName} maxLinesPerFile`, 10, 500);
  const byteLimit = validateInteger(maxBytesPerFile, `${toolName} maxBytesPerFile`, 1024, MAX_BYTES);
  const totalLineLimit = validateInteger(maxTotalLines, `${toolName} maxTotalLines`, 10, 500);
  const totalLimit = validateInteger(maxTotalBytes, `${toolName} maxTotalBytes`, 1024, MAX_BYTES);
  const previewArgsList = [];

  for (const filePath of paths) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      invalidParams(`${toolName} paths must contain non-empty strings`);
    }
    const previewArgs = { path: filePath, maxLines: lineLimit, maxBytes: byteLimit, lineNumbers };
    if (filePath === rangePath) {
      previewArgs.fromLine = fromLine;
      previewArgs.toLine = toLine;
    }
    previewArgsList.push(previewArgs);
  }

  const results = await mapLimited(previewArgsList, READ_MANY_CONCURRENCY, (previewArgs) => readFilePreview(previewArgs, toolName));

  const formatted = formatReadManyOutput(results, totalLineLimit, totalLimit);
  const totalBytes = results.reduce((sum, result) => sum + result._meta.response.totalBytes, 0);
  const contextSavings = savingsForReturnedBytes(totalBytes, formatted.returnedBytes);
  const truncated = formatted.truncated || results.some((result) => result._meta.truncated);
  const meta = withResponseMeta({
    filesRequested: paths.length,
    filesRead: results.length,
    maxTotalLines: totalLineLimit,
    totalLines: formatted.totalLines,
    totalBytes,
    ...contextSavings,
    truncated,
    ...truncationMeta(truncated, readManyTruncationReason(formatted, totalLineLimit, totalLimit, results), "Increase maxTotalLines/maxTotalBytes or per-file limits."),
    files: results.map(readManyFileMeta),
  });
  await recordStats(toolName, meta);

  return toolTextResult(formatted.text, meta, totalLimit);
}

export async function readRangesTool(args, toolName = "read") {
  const {
    ranges,
    maxLines,
    maxBytes,
    maxLinesPerFile = maxLines ?? MAX_LINES,
    maxBytesPerFile = maxBytes ?? DEFAULT_BYTES,
    maxTotalLines = 200,
    maxTotalBytes = DEFAULT_BYTES,
    lineNumbers,
  } = args ?? {};

  if (args?.path !== undefined || args?.paths !== undefined || args?.fromLine !== undefined || args?.toLine !== undefined) {
    invalidParams(`${toolName} ranges cannot be combined with path, paths, fromLine, or toLine`);
  }
  if (!Array.isArray(ranges) || ranges.length === 0) invalidParams(`${toolName} ranges must be a non-empty array`);
  if (ranges.length > 20) invalidParams(`${toolName} ranges must contain at most 20 items`);
  if (lineNumbers !== undefined && typeof lineNumbers !== "boolean") invalidParams(`${toolName} lineNumbers must be a boolean when provided`);

  const lineLimit = validateInteger(maxLinesPerFile, `${toolName} maxLinesPerFile`, 10, 500);
  const byteLimit = validateInteger(maxBytesPerFile, `${toolName} maxBytesPerFile`, 1024, MAX_BYTES);
  const totalLineLimit = validateInteger(maxTotalLines, `${toolName} maxTotalLines`, 10, 500);
  const totalLimit = validateInteger(maxTotalBytes, `${toolName} maxTotalBytes`, 1024, MAX_BYTES);
  const numberSnippets = lineNumbers !== false;
  const previewArgsList = ranges.map((range, index) => normalizeSnippetRange(range, index, lineLimit, byteLimit, numberSnippets, toolName));

  const results = await mapLimited(previewArgsList, READ_MANY_CONCURRENCY, (previewArgs) => readFilePreview(previewArgs, toolName));
  const formatted = formatReadManyOutput(results, totalLineLimit, totalLimit);
  const totalBytes = results.reduce((sum, result) => sum + result._meta.response.totalBytes, 0);
  const contextSavings = savingsForReturnedBytes(totalBytes, formatted.returnedBytes);
  const truncated = formatted.truncated || results.some((result) => result._meta.truncated);
  const meta = withResponseMeta({
    rangesRequested: ranges.length,
    rangesRead: results.length,
    maxTotalLines: totalLineLimit,
    totalLines: formatted.totalLines,
    totalBytes,
    ...contextSavings,
    truncated,
    ...truncationMeta(truncated, readManyTruncationReason(formatted, totalLineLimit, totalLimit, results), "Increase maxTotalLines/maxTotalBytes or per-snippet limits."),
    ranges: results.map(readManyFileMeta),
  });
  await recordStats(toolName, meta);

  return toolTextResult(formatted.text, meta, totalLimit);
}

function normalizeSnippetRange(range, index, maxLines, maxBytes, lineNumbers, toolName) {
  if (range === null || typeof range !== "object" || Array.isArray(range)) {
    invalidParams(`${toolName} ranges[${index}] must be an object`);
  }
  const allowed = new Set(["path", "fromLine", "toLine"]);
  const unknown = Object.keys(range).find((key) => !allowed.has(key));
  if (unknown) invalidParams(`${toolName} ranges[${index}] has unknown property: ${unknown}`);
  if (typeof range.path !== "string" || range.path.trim() === "") {
    invalidParams(`${toolName} ranges[${index}].path must be a non-empty string`);
  }
  normalizeLineRange(range.fromLine, range.toLine, `${toolName} ranges[${index}]`);
  return {
    path: range.path,
    fromLine: range.fromLine,
    toLine: range.toLine,
    maxLines,
    maxBytes,
    lineNumbers,
  };
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readFilePreview(args, toolName) {
  const { path: filePath, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES, fromLine, toLine, lineNumbers = false } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") {
    invalidParams(`${toolName} requires a non-empty path string`);
  }
  const lineLimit = validateInteger(maxLines, `${toolName} maxLines`, 10, 500);
  const byteLimit = validateInteger(maxBytes, `${toolName} maxBytes`, 1024, MAX_BYTES);
  if (typeof lineNumbers !== "boolean") invalidParams(`${toolName} lineNumbers must be a boolean when provided`);

  const resolved = path.resolve(filePath);
  await assertPathAllowed(resolved, toolName);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) {
    const error = new Error(`Not a file: ${filePath}`);
    error.code = -32602;
    throw error;
  }

  const rangeMode = fromLine !== undefined || toLine !== undefined;
  const range = rangeMode ? normalizeLineRange(fromLine, toLine, toolName) : undefined;
  const responseByteLimit = Math.min(byteLimit, MAX_READ_BYTES);
  const rangeByteLimit = rangeMode ? readRangeContentByteLimit(resolved, range, responseByteLimit, lineNumbers) : MAX_READ_BYTES;
  const { text, limited, rangeLimited, returnedLines, scannedLines, scannedBytes, scanLimited, scanTimedOut, rangeContentBytes } = rangeMode
    ? await readLineRange(resolved, range.fromLine, range.toLine, lineLimit, rangeByteLimit, MAX_READ_BYTES, READ_RANGE_TIMEOUT_MS)
    : await readLimitedFile(resolved, stat.size, MAX_READ_BYTES);
  const displayText = lineNumbers ? addLineNumbers(text, range?.fromLine ?? 1) : text;
  const rangeMinimumContentBytes = rangeMode
    ? minimumRangeContentBytes(rangeContentBytes, { limited, rangeLimited, scanLimited, scanTimedOut })
    : undefined;
  const formatted = rangeMode
    ? formatReadRangeOutput(displayText, resolved, range, lineLimit, responseByteLimit, rangeMinimumContentBytes)
    : formatOutput(displayText, lineLimit, responseByteLimit);
  const truncated = formatted.truncated || rangeLimited || limited || scanLimited || scanTimedOut;
  const totalBytes = rangeMode
    ? minimumTruncatedTotalBytes(formatted.totalBytes, formatted.returnedBytes, truncated)
    : nonRangeTotalBytes(stat.size, formatted, lineNumbers, truncated);
  const contextSavings = savingsForReturnedBytes(totalBytes, formatted.returnedBytes);
  const emptyReason = readEmptyReason({ rangeMode, sizeBytes: stat.size, text, returnedLines });
  const meta = withResponseMeta({
    path: resolved,
    relativePath: relativePath(resolved),
    sizeBytes: stat.size,
    totalLines: formatted.totalLines,
    totalBytes,
    ...contextSavings,
    truncated,
    ...truncationMeta(truncated, readTruncationReason({ formatted, lineLimit, byteLimit, limited, rangeMode, rangeLimited, scanLimited, scanTimedOut }), readTruncationHint({ rangeMode, lineNumbers })),
    empty: emptyReason !== undefined,
    emptyReason,
    fileReadLimited: limited,
    fromLine: range?.fromLine,
    toLine: range?.toLine === Infinity ? undefined : range?.toLine,
    returnedLines,
    scannedLines,
    scannedBytes,
    scanLimited,
    rangeLimited,
    scanTimedOut,
    lineNumbers,
  });
  return toolTextResult(formatted.text, meta, responseByteLimit);
}

function nonRangeTotalBytes(sizeBytes, formatted, lineNumbers, truncated) {
  if (!lineNumbers) return sizeBytes;
  const displayTotalBytes = Math.max(sizeBytes, formatted.totalBytes);
  return minimumTruncatedTotalBytes(displayTotalBytes, formatted.returnedBytes, truncated);
}

function savingsForReturnedBytes(totalBytes, returnedBytes) {
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}

function minimumRangeContentBytes(rangeContentBytes = 0, { limited, rangeLimited, scanLimited, scanTimedOut }) {
  if (rangeLimited || scanLimited || scanTimedOut) return rangeContentBytes + 1;
  return limited ? Math.max(rangeContentBytes, 1) : rangeContentBytes;
}

function minimumTruncatedTotalBytes(totalBytes, returnedBytes, truncated) {
  return truncated ? Math.max(totalBytes, returnedBytes + 1) : totalBytes;
}

function readTruncationReason({ formatted, lineLimit, byteLimit, limited, rangeMode, rangeLimited, scanLimited, scanTimedOut }) {
  if (scanLimited || scanTimedOut) return "scan_limit";
  if (rangeLimited || (rangeMode && limited)) return "range_limit";
  if (limited) return "file_limit";
  return formatTruncationReason(formatted, lineLimit, byteLimit) ?? "format_limit";
}

function readTruncationHint({ rangeMode }) {
  return rangeMode ? "Narrow fromLine/toLine or increase maxLines/maxBytes." : "Increase maxLines/maxBytes or read a smaller file.";
}

function readRangeContentByteLimit(resolvedPath, range, maxBytes, lineNumbers) {
  const headerBytes = Buffer.byteLength(`${readRangeHeader(resolvedPath, range)}\n`, "utf8");
  const lineNumberReserve = lineNumbers ? Math.max(0, String(range.fromLine).length + 2) : 0;
  return Math.max(0, maxBytes - headerBytes - lineNumberReserve);
}

function readEmptyReason({ rangeMode, sizeBytes, text, returnedLines }) {
  if (sizeBytes === 0 && text === "") return "empty_file";
  if (rangeMode && returnedLines === 0) return "empty_range";
  if (!rangeMode && text === "") return "empty_file";
  return undefined;
}

function formatReadRangeOutput(text, resolvedPath, range, maxLines, maxBytes, minimumContentBytes = 0) {
  const header = readRangeHeader(resolvedPath, range);
  const headerBytes = Buffer.byteLength(`${header}\n`, "utf8");
  const contentLimit = Math.max(1024, maxBytes - headerBytes);
  const content = formatOutput(text, maxLines, contentLimit);
  let contentText = content.text;
  let trimmedForHeader = false;

  const allowedContentBytes = Math.max(0, maxBytes - headerBytes);
  if (Buffer.byteLength(contentText, "utf8") > allowedContentBytes) {
    contentText = decodeUtf8(Buffer.from(contentText, "utf8").subarray(0, allowedContentBytes), { trimEnd: true });
    trimmedForHeader = true;
  }

  const output = `${header}\n${contentText}`;
  const returnedBytes = Buffer.byteLength(output, "utf8");
  const totalBytes = Math.max(returnedBytes, headerBytes + content.totalBytes, headerBytes + minimumContentBytes);
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    text: output,
    totalLines: output.split("\n").length,
    totalBytes,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
    truncated: content.truncated || trimmedForHeader,
  };
}

function readRangeHeader(resolvedPath, range) {
  const displayPath = relativePath(resolvedPath) ?? resolvedPath;
  const end = range.toLine === Infinity ? "end" : range.toLine;
  return `--- ${displayPath}:${range.fromLine}-${end} ---`;
}

function readManyTruncationReason(formatted, maxLines, maxBytes, results) {
  return formatTruncationReason(formatted, maxLines, maxBytes)
    ?? results.find((result) => result._meta.truncated)?._meta.truncation?.reason
    ?? "file_limit";
}

function formatReadManyOutput(results, maxLines, maxBytes) {
  const sections = results.map(readManyOutputSection);
  const combined = sections.map((section) => [section.header, section.text].join("\n")).join("\n\n");
  const formatted = formatOutput(combined, maxLines, maxBytes);
  if (!formatted.truncated) return formatted;

  const text = trimReadManySummaryToBytes(buildReadManySummary(sections, formatted.totalLines, formatted.totalBytes, maxLines), maxBytes);
  const savings = savingsForText(combined, text);

  return {
    text,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    returnedBytes: savings.returnedBytes,
    savedBytes: savings.savedBytes,
    savedPercent: savings.savedPercent,
    estimatedTokensSaved: savings.estimatedTokensSaved,
    truncated: true,
  };
}

function readManyOutputSection(result) {
  const name = result._meta.relativePath ?? result._meta.path;
  const header = readManySectionHeader(result, name);
  const text = stripNestedReadRetryHints(stripDuplicateSectionHeader(result.content[0].text, header));
  return {
    name,
    header,
    text,
    contentLines: text.split("\n"),
  };
}

function readManySectionHeader(result, name) {
  if (result._meta.fromLine !== undefined) {
    const end = result._meta.toLine === undefined ? "end" : result._meta.toLine;
    return `--- ${name}:${result._meta.fromLine}-${end} ---`;
  }
  return `--- ${name} ---`;
}

function stripDuplicateSectionHeader(text, header) {
  return text === header ? "" : text.startsWith(`${header}\n`) ? text.slice(header.length + 1) : text;
}

function stripNestedReadRetryHints(text) {
  return text
    .replace(/^\[truncated:/gm, "[file truncated:")
    .replaceAll("; raise maxLines/maxBytes", "")
    .replaceAll("; increase maxLines/maxBytes", "")
    .replace(/\n?\[retry: [^\]]+\]/g, "");
}

function buildReadManySummary(sections, totalLines, totalBytes, maxLines) {
  const markerLines = 2;
  const available = Math.max(2, maxLines - markerLines);
  const headBudget = Math.max(1, Math.floor(available * 0.4));
  const tailBudget = Math.max(1, available - headBudget);
  const head = takeReadManyHead(sections, headBudget);
  const tail = markContinuedTailHeaders(takeReadManyTail(sections, tailBudget), head);

  return [
    `[truncated: multi-file total limit; ${totalLines} lines, ${(totalBytes / 1024).toFixed(1)} KB; showing first ${head.length} + last ${tail.length}]`,
    ...head,
    "[omitted: middle file content]",
    ...tail,
  ].join("\n");
}

function markContinuedTailHeaders(tail, head) {
  const headHeaders = new Set(head.filter(isReadManyHeaderLine));
  return tail.map((line) => headHeaders.has(line) ? line.replace(/ ---$/, " continued ---") : line);
}

function isReadManyHeaderLine(line) {
  return /^--- .+ ---$/.test(line);
}

function takeReadManyHead(sections, budget) {
  const output = [];
  let remaining = budget;
  for (const section of sections) {
    if (remaining <= 0) break;
    const sectionLines = [section.header, ...section.contentLines];
    if (sectionLines.length <= remaining) {
      output.push(...sectionLines);
      remaining -= sectionLines.length;
      continue;
    }

    output.push(section.header);
    remaining--;
    if (remaining > 1) {
      const shownContentLines = remaining - 1;
      output.push(...section.contentLines.slice(0, shownContentLines));
      output.push(`[omitted: more lines from ${section.name}]`);
    } else if (remaining === 1) {
      output.push(...section.contentLines.slice(0, 1));
    }
    break;
  }
  return output;
}

function takeReadManyTail(sections, budget) {
  const output = [];
  let remaining = budget;
  for (let index = sections.length - 1; index >= 0; index--) {
    if (remaining <= 0) break;
    const section = sections[index];
    const sectionLines = [section.header, ...section.contentLines];
    if (sectionLines.length <= remaining) {
      output.unshift(...sectionLines);
      remaining -= sectionLines.length;
      continue;
    }

    const partial = [section.header];
    remaining--;
    if (remaining > 1) {
      const shownContentLines = remaining - 1;
      partial.push(`[omitted: earlier lines from ${section.name}]`);
      partial.push(...section.contentLines.slice(-shownContentLines));
    } else if (remaining === 1) {
      partial.push(...section.contentLines.slice(-1));
    }
    output.unshift(...partial);
    break;
  }
  return output;
}

function trimReadManySummaryToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const lines = text.split("\n");

  for (let attempts = 0; attempts < 64 && Buffer.byteLength(lines.join("\n"), "utf8") > maxBytes; attempts++) {
    const longestIndex = longestContentLineIndex(lines);
    if (longestIndex === -1) break;
    const line = lines[longestIndex];
    const clippedBytes = Math.max(0, Math.floor(Buffer.byteLength(line, "utf8") * 0.6));
    const clipped = decodeUtf8(Buffer.from(line, "utf8").subarray(0, clippedBytes), { trimEnd: true });
    lines[longestIndex] = clipped ? `${clipped}…` : "…";
  }

  const trimmed = lines.join("\n");
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
  return decodeUtf8(Buffer.from(trimmed, "utf8").subarray(0, maxBytes), { trimEnd: true });
}

function longestContentLineIndex(lines) {
  let bestIndex = -1;
  let bestBytes = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("--- ") || line.startsWith("[")) continue;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function readManyFileMeta(result) {
  return omitUndefined({
    path: result._meta.path,
    relativePath: result._meta.relativePath,
    sizeBytes: result._meta.sizeBytes,
    truncated: result._meta.truncated,
    truncation: result._meta.truncation,
    fileReadLimited: result._meta.fileReadLimited,
    fromLine: result._meta.fromLine,
    toLine: result._meta.toLine,
    returnedLines: result._meta.returnedLines,
    scannedLines: result._meta.scannedLines,
    scannedBytes: result._meta.scannedBytes,
    scanLimited: result._meta.scanLimited,
    rangeLimited: result._meta.rangeLimited,
    scanTimedOut: result._meta.scanTimedOut,
    lineNumbers: result._meta.lineNumbers,
    response: result._meta.truncated ? result._meta.response : undefined,
  });
}

function addLineNumbers(text, firstLine) {
  if (text === "") return text;
  const hasTrailingNewline = text.endsWith("\n");
  const body = hasTrailingNewline ? text.slice(0, -1) : text;
  if (body === "") return text;
  const lines = body.split("\n");
  const width = String(firstLine + lines.length - 1).length;
  const numbered = lines.map((line, index) => `${String(firstLine + index).padStart(width, " ")}: ${line}`).join("\n");
  return hasTrailingNewline ? `${numbered}\n` : numbered;
}

function normalizeLineRange(fromLine, toLine, label = "read") {
  const from = fromLine === undefined ? 1 : validateInteger(fromLine, `${label} fromLine`, 1);
  const to = toLine === undefined ? Infinity : validateInteger(toLine, `${label} toLine`, 1);

  if (to < from) {
    invalidParams(`${label} toLine must be greater than or equal to fromLine`);
  }

  return { fromLine: from, toLine: to };
}

async function readLineRange(filePath, fromLine, toLine, maxLines, maxBytes, maxScanBytes, timeoutMs) {
  const input = fs.createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  const collector = createLineRangeCollector(fromLine, toLine, maxLines, maxBytes);
  let scannedBytes = 0;
  let scanLimited = false;
  let scanTimedOut = false;
  const timer = setTimeout(() => {
    scanTimedOut = true;
    input.destroy(new Error("read range scan timed out"));
  }, timeoutMs);
  timer.unref();

  try {
    for await (const chunk of input) {
      scannedBytes += chunk.byteLength;
      if (!collector.processText(decoder.write(chunk))) {
        input.destroy();
        break;
      }
      if (collector.scannedLines < toLine && scannedBytes > maxScanBytes) {
        scanLimited = true;
        input.destroy();
        break;
      }
    }

    if (!collector.stopped && !scanLimited && !scanTimedOut && collector.scannedLines < toLine) {
      collector.finishText(decoder.end());
    }
  } catch (error) {
    if (!scanTimedOut) throw error;
  } finally {
    clearTimeout(timer);
    input.destroy();
  }

  return collector.result(scannedBytes, scanLimited, scanTimedOut);
}

function createLineRangeCollector(fromLine, toLine, maxLines, maxBytes) {
  const lines = [];
  let lineNumber = 0;
  let bytes = 0;
  let rangeContentBytes = 0;
  let limited = false;
  let rangeLimited = false;
  let currentLine = "";

  function shouldCollectCurrentLine() {
    const currentLineNumber = lineNumber + 1;
    return currentLineNumber >= fromLine && currentLineNumber <= toLine;
  }

  function appendToCurrentLine(text) {
    if (!shouldCollectCurrentLine()) return true;
    if (lines.length >= maxLines) {
      rangeLimited = true;
      return false;
    }

    const nextLine = currentLine + text;
    const separatorBytes = lines.length > 0 ? 1 : 0;
    const nextLineBytes = Buffer.byteLength(nextLine, "utf8");
    rangeContentBytes = Math.max(rangeContentBytes, bytes + separatorBytes + nextLineBytes);
    if (bytes + separatorBytes + nextLineBytes > maxBytes) {
      limited = true;
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        const clipped = decodeUtf8(Buffer.from(nextLine, "utf8").subarray(0, remaining), { trimEnd: true });
        if (clipped) {
          lines.push(clipped);
          bytes += separatorBytes + Buffer.byteLength(clipped, "utf8");
          lineNumber++;
        }
      }
      currentLine = "";
      return false;
    }

    currentLine = nextLine;
    return true;
  }

  function finishCurrentLine() {
    const line = currentLine.endsWith("\r") ? currentLine.slice(0, -1) : currentLine;
    currentLine = "";
    lineNumber++;

    if (lineNumber < fromLine) return true;
    if (lineNumber > toLine) return false;

    const separatorBytes = lines.length > 0 ? 1 : 0;
    const nextBytes = separatorBytes + Buffer.byteLength(line, "utf8");
    rangeContentBytes = Math.max(rangeContentBytes, bytes + nextBytes);
    if (bytes + nextBytes > maxBytes) {
      limited = true;
      return false;
    }

    lines.push(line);
    bytes += nextBytes;

    if (lines.length >= maxLines && lineNumber < toLine) {
      rangeLimited = true;
      return false;
    }

    return true;
  }

  function processText(text) {
    let offset = 0;

    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const part = newline === -1 ? text.slice(offset) : text.slice(offset, newline);
      if (!appendToCurrentLine(part)) return false;
      if (newline === -1) return true;
      if (!finishCurrentLine()) return false;
      offset = newline + 1;
    }

    return true;
  }

  return {
    processText,
    finishText(text) {
      processText(text);
      if (currentLine) finishCurrentLine();
    },
    get scannedLines() {
      return lineNumber;
    },
    get stopped() {
      return limited || rangeLimited;
    },
    result(scannedBytes, scanLimited, scanTimedOut) {
      return {
        text: lines.join("\n"),
        limited,
        rangeLimited,
        returnedLines: lines.length,
        scannedLines: lineNumber,
        scannedBytes,
        scanLimited,
        scanTimedOut,
        rangeContentBytes,
      };
    },
  };
}

async function readLimitedFile(filePath, size, maxBytes) {
  if (size <= maxBytes) {
    return { text: await fs.promises.readFile(filePath, "utf8"), limited: false, rangeLimited: false };
  }

  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  const file = await fs.promises.open(filePath, "r");

  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, headBytes, 0);
    const tailRead = await file.read(tail, 0, tailBytes, size - tailBytes);

    return {
      text: [
        decodeUtf8(head.subarray(0, headRead.bytesRead), { trimEnd: true }),
        omission("bytes", Math.max(0, size - maxBytes)),
        decodeUtf8(tail.subarray(0, tailRead.bytesRead), { trimStart: true }),
      ].join("\n"),
      limited: true,
      rangeLimited: false,
    };
  } finally {
    await file.close();
  }
}
