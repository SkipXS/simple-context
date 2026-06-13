import * as path from "node:path";

export function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function integerRange(min, max) {
  return max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
}

export function validateInteger(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidParams(`${name} must be an integer ${integerRange(min, max)}`);
  }
  if (value < min || (max !== undefined && value > max)) {
    invalidParams(`${name} must be ${integerRange(min, max)}`);
  }
  return value;
}

export function savingsMeta(formatted) {
  return {
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    savedPercent: formatted.savedPercent,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
  };
}

const RESPONSE_META_KEYS = new Set([
  "totalLines",
  "totalBytes",
  "totalBytesKnown",
  "returnedBytes",
  "savedBytes",
  "savedPercent",
  "estimatedTokensSaved",
]);

export function responseMeta(meta) {
  return {
    totalLines: meta.totalLines,
    totalBytes: meta.totalBytes,
    totalBytesKnown: meta.totalBytesKnown,
    returnedBytes: meta.returnedBytes,
    savedBytes: meta.savedBytes,
    savedPercent: meta.savedPercent,
    estimatedTokensSaved: meta.estimatedTokensSaved,
    truncated: Boolean(meta.truncated),
  };
}

export function truncationDiagnostic(reason, retryHint) {
  const diagnostic = { reason };
  if (retryHint) diagnostic.retryHint = retryHint;
  return diagnostic;
}

export function truncationMeta(truncated, reason, retryHint) {
  return truncated ? { truncation: truncationDiagnostic(reason, retryHint) } : {};
}

export function formatTruncationReason(formatted, maxLines, maxBytes) {
  if (!formatted?.truncated) return undefined;
  if (formatted.totalLines > maxLines) return "format_lines";
  if (formatted.totalBytes > maxBytes) return "format_bytes";
  return "format_limit";
}

export function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function withResponseMeta(meta) {
  const compact = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!RESPONSE_META_KEYS.has(key)) compact[key] = value;
  }
  return { ...compact, response: responseMeta(meta) };
}

export function relativePath(filePath, root = process.cwd()) {
  if (typeof filePath !== "string" || filePath.trim() === "") return undefined;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return resolvedPath;
  return relative.replaceAll(path.sep, "/");
}

export function omission(kind, count) {
  const amount = Number.isFinite(count) ? String(count) : "more";
  return `[omitted: ${amount} ${kind}]`;
}

export function savingsForText(originalText, returnedText) {
  const totalBytes = Buffer.byteLength(originalText, "utf8");
  const returnedBytes = Buffer.byteLength(returnedText, "utf8");
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    totalBytes,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}

export function toolTextResult(text, meta, maxBytes) {
  const finalText = appendVisibleTruncationNotice(text, meta, maxBytes);
  return {
    content: [{ type: "text", text: finalText }],
    _meta: finalText === text ? meta : updateReturnedBytes(meta, finalText),
  };
}

function appendVisibleTruncationNotice(text, meta, maxBytes = Number.POSITIVE_INFINITY) {
  if (!meta?.truncated || !meta.truncation?.reason) return text;

  const hint = meta.truncation.retryHint ? `; ${meta.truncation.retryHint}` : "";
  const notice = `[truncated: ${meta.truncation.reason}${hint}]`;
  if (text.includes(notice)) return text;

  const knownLowerBound = meta.response?.totalBytesKnown === false && Number.isFinite(meta.response?.totalBytes)
    ? meta.response.totalBytes
    : Number.POSITIVE_INFINITY;
  const effectiveMaxBytes = Math.min(maxBytes, knownLowerBound);
  const candidate = `${text}\n${notice}`;
  return Buffer.byteLength(candidate, "utf8") <= effectiveMaxBytes ? candidate : text;
}

function updateReturnedBytes(meta, text) {
  const returnedBytes = Buffer.byteLength(text, "utf8");
  const response = meta.response && typeof meta.response === "object" ? { ...meta.response } : {};
  const totalBytes = Math.max(response.totalBytes ?? returnedBytes, returnedBytes);
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  response.totalBytes = totalBytes;
  response.returnedBytes = returnedBytes;
  response.savedBytes = savedBytes;
  response.savedPercent = totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0;
  response.estimatedTokensSaved = Math.ceil(savedBytes / 4);
  response.truncated = Boolean(meta.truncated);

  return { ...meta, response };
}
