import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES, MAX_READ_BYTES } from "../constants.js";
import { formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

export async function outlineTool(args) {
  const { path: filePath, maxSymbols = 200, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") invalidParams("context_file_outline requires a non-empty path string");
  const symbolLimit = validateInteger(maxSymbols, "context_file_outline maxSymbols", 1, 1000);
  const lineLimit = validateInteger(maxLines, "context_file_outline maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_file_outline maxBytes", 1024, MAX_BYTES);
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) invalidParams(`Not a file: ${filePath}`);
  if (stat.size > MAX_READ_BYTES) invalidParams(`File is too large for outline: ${filePath}`);

  const started = Date.now();
  const text = await fs.promises.readFile(resolved, "utf8");
  const outline = extractOutline(text);
  const symbols = outline.slice(0, symbolLimit);
  const output = symbols.length > 0 ? symbols.join("\n") : "(no outline symbols found)";
  const formatted = formatOutput(output, lineLimit, byteLimit);
  const meta = {
    path: resolved,
    sizeBytes: stat.size,
    symbolsFound: outline.length,
    symbolsShown: symbols.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: outline.length > symbols.length || formatted.truncated,
    durationMs: Date.now() - started,
  };
  await recordStats("context_file_outline", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

function extractOutline(text) {
  const patterns = [
    /^\s*import\s.+/,
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/,
    /^\s*(?:export\s+)?class\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/,
  ];
  const symbols = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (patterns.some((pattern) => pattern.test(line))) symbols.push(`${index + 1}: ${line.trim()}`);
  }
  return symbols;
}
