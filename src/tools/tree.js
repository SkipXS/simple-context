import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { invalidParams, savingsMeta, validateInteger } from "./shared.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export async function treeTool(args) {
  const { path: inputPath = ".", maxDepth = 3, maxEntries = 200, maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("context_tree path must be a non-empty string when provided");
  const depthLimit = validateInteger(maxDepth, "context_tree maxDepth", 1, 10);
  const entryLimit = validateInteger(maxEntries, "context_tree maxEntries", 1, 2000);
  const lineLimit = validateInteger(maxLines, "context_tree maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_tree maxBytes", 1024, MAX_BYTES);

  const started = Date.now();
  const root = path.resolve(inputPath);
  const state = { entries: 0, omitted: 0 };
  const lines = [path.basename(root) || root];
  await appendTree(root, "", 1, depthLimit, entryLimit, state, lines);
  if (state.omitted > 0) lines.push(`... ${state.omitted} entries omitted ...`);

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = {
    root,
    entriesShown: state.entries,
    entriesOmitted: state.omitted,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated: state.omitted > 0 || formatted.truncated,
    durationMs: Date.now() - started,
  };
  await recordStats("context_tree", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function appendTree(directory, prefix, depth, maxDepth, maxEntries, state, lines) {
  if (depth > maxDepth || state.entries >= maxEntries) return;
  const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  for (const [index, entry] of entries.entries()) {
    if (state.entries >= maxEntries) {
      state.omitted += entries.length - index;
      return;
    }
    const last = index === entries.length - 1;
    lines.push(`${prefix}${last ? "└──" : "├──"} ${entry.name}${entry.isDirectory() ? "/" : ""}`);
    state.entries++;
    if (entry.isDirectory()) await appendTree(path.join(directory, entry.name), `${prefix}${last ? "    " : "│   "}`, depth + 1, maxDepth, maxEntries, state, lines);
  }
}
