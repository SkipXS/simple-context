import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BYTES, MAX_BYTES, MAX_LINES, projectKey } from "../constants.js";
import { formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { assertPathAllowed, displayPath, formatTruncationReason, invalidParams, relativePath, savingsMeta, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

const DEFAULT_MAX_MATCHES = 10;
const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "dist", "build", "coverage", ".cache", ".next", ".nuxt", "out", "target", "tmp", "temp"]);
const MAX_SCAN_ENTRIES = 25_000;

export async function resolveTool(args) {
  const { path: inputPath, root, maxMatches = DEFAULT_MAX_MATCHES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("resolve path must be a non-empty string");
  if (root !== undefined && (typeof root !== "string" || root.trim() === "")) invalidParams("resolve root must be a non-empty string when provided");
  const matchLimit = validateInteger(maxMatches, "resolve maxMatches", 1, 50);

  const started = Date.now();
  const normalizedInput = normalizeSeparators(inputPath.trim());
  const searchRootInput = normalizeSeparators((root ?? projectKey() ?? ".").trim());
  const searchRoot = path.resolve(searchRootInput);
  await assertPathAllowed(searchRoot, "resolve");

  let rootStat;
  try {
    rootStat = await fs.promises.stat(searchRoot);
  } catch {
    invalidParams(`resolve root does not exist: ${root ?? "."}`);
  }
  if (!rootStat.isDirectory()) invalidParams(`resolve root is not a directory: ${root ?? "."}`);

  const candidate = resolveCandidate(normalizedInput, searchRoot);
  await assertPathAllowed(candidate, "resolve");

  const existing = await existingPathResult(candidate, searchRoot);
  if (existing) {
    const text = [
      `Resolved: ${existing.realPath}`,
      `Type: ${existing.type}`,
      existing.projectRelativePath ? `Project relative: ${existing.projectRelativePath}` : undefined,
      `Root: ${existing.root}`,
    ].filter(Boolean).join("\n");
    return await finish("exists", text, {
      inputPath,
      normalizedInput,
      root: existing.root,
      path: existing.path,
      realPath: existing.realPath,
      type: existing.type,
      projectRelativePath: existing.projectRelativePath,
      exists: true,
      candidatesShown: 0,
      scannedEntries: 0,
      scanLimited: false,
      durationMs: Date.now() - started,
    });
  }

  const search = await findCandidates(searchRoot, normalizedInput, matchLimit);
  const lines = search.candidates.length > 0
    ? [
        `Missing: ${normalizedInput}`,
        `Closest candidates under ${relativePath(searchRoot)}:`,
        ...search.candidates.map((entry) => `${entry.relativePath} (${entry.type})`),
      ]
    : [`Missing: ${normalizedInput}`, `No close candidates found under ${relativePath(searchRoot)}.`];
  const truncated = search.limited || search.totalCandidates > search.candidates.length;
  return await finish("missing", lines.join("\n"), {
    inputPath,
    normalizedInput,
    root: searchRoot,
    attemptedPath: candidate,
    exists: false,
    candidatesShown: search.candidates.length,
    totalCandidates: truncated ? undefined : search.totalCandidates,
    totalCandidatesKnown: !truncated,
    scannedEntries: search.scannedEntries,
    scanLimited: search.limited,
    truncated,
    truncationReason: truncated ? "max_matches" : undefined,
    durationMs: Date.now() - started,
  });
}

function normalizeSeparators(value) {
  return value.replace(/[\\/]+/g, path.sep);
}

function resolveCandidate(inputPath, root) {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  return path.resolve(root, inputPath);
}

async function existingPathResult(candidate, root) {
  let stat;
  try {
    stat = await fs.promises.stat(candidate);
  } catch {
    return undefined;
  }

  const realPath = await fs.promises.realpath(candidate).catch(() => path.resolve(candidate));
  const realRoot = await fs.promises.realpath(root).catch(() => path.resolve(root));
  return {
    path: displayPath(path.resolve(candidate)),
    realPath,
    root,
    type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
    projectRelativePath: relativePath(realPath, realRoot),
  };
}

async function findCandidates(root, inputPath, maxMatches) {
  const targetSegments = splitSegments(inputPath);
  const targetBase = targetSegments.at(-1)?.toLowerCase() ?? inputPath.toLowerCase();
  const scored = [];
  let scannedEntries = 0;
  let limited = false;

  async function walk(dir) {
    if (scannedEntries >= MAX_SCAN_ENTRIES) {
      limited = true;
      return;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scannedEntries >= MAX_SCAN_ENTRIES) {
        limited = true;
        return;
      }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const absolutePath = path.join(dir, entry.name);
      scannedEntries++;
      const relative = relativePath(absolutePath, root);
      const score = scoreCandidate(relative, entry.name, targetBase, targetSegments);
      if (score > 0) {
        scored.push({
          path: absolutePath,
          relativePath: relative,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
          score,
        });
      }
      if (entry.isDirectory()) await walk(absolutePath);
    }
  }

  await walk(root);
  scored.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return { candidates: scored.slice(0, maxMatches), totalCandidates: scored.length, scannedEntries, limited };
}

function splitSegments(value) {
  return normalizeSeparators(value)
    .split(path.sep)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
}

function scoreCandidate(relative, name, targetBase, targetSegments) {
  const relativeLower = relative.toLowerCase();
  const nameLower = name.toLowerCase();
  let score = 0;

  if (nameLower === targetBase) score += 100;
  else if (nameLower.includes(targetBase) || targetBase.includes(nameLower)) score += 50;
  else if (targetBase && fuzzyIncludes(nameLower, targetBase)) score += 20;

  for (const segment of targetSegments.slice(0, -1)) {
    const lower = segment.toLowerCase();
    if (relativeLower.includes(lower)) score += 12;
  }

  if (targetSegments.length > 1 && relativeLower.endsWith(targetSegments.join("/").toLowerCase())) score += 40;
  return score;
}

function fuzzyIncludes(candidate, target) {
  let index = 0;
  for (const char of candidate) {
    if (char === target[index]) index++;
    if (index === target.length) return true;
  }
  return false;
}

async function finish(mode, text, metaFields) {
  const formatted = formatOutput(text, MAX_LINES, DEFAULT_BYTES);
  const truncated = Boolean(metaFields.truncated || formatted.truncated);
  const meta = withResponseMeta({
    mode,
    ...metaFields,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, metaFields.truncationReason ?? formatTruncationReason(formatted, MAX_LINES, DEFAULT_BYTES), "Increase maxMatches or narrow root/path."),
  });
  await recordStats("resolve", meta);
  return toolTextResult(formatted.text, meta, Math.min(DEFAULT_BYTES, MAX_BYTES));
}
