import { MAX_BYTES, MAX_LINES } from "./constants.js";

export function normalizeMaxLines(maxLines = MAX_LINES) {
  const numeric = Number(maxLines);
  const value = Number.isFinite(numeric) ? Math.trunc(numeric) : MAX_LINES;
  return Math.max(10, Math.min(value, 200));
}

export function normalizeLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function formatOutput(output, maxLines = MAX_LINES) {
  const limit = normalizeMaxLines(maxLines);
  const totalBytes = Buffer.byteLength(output, "utf8");
  const lines = output.split("\n");
  const totalLines = lines.length;

  if (totalLines <= limit && totalBytes <= MAX_BYTES) {
    return { text: output || "(no output)", totalLines, totalBytes, truncated: false };
  }

  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const summary = [
    `╔══ ${totalLines} lines · ${(totalBytes / 1024).toFixed(1)} KB · showing first ${head} + last ${tail} ══╗`,
    ...lines.slice(0, head),
    `╟── … ${totalLines - head - tail} lines omitted … ──╢`,
    ...lines.slice(-tail),
    `╚${"═".repeat(58)}╝`,
  ].join("\n");

  return { text: summary, totalLines, totalBytes, truncated: true };
}
