import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BYTES, MAX_BYTES, MAX_LINES, MAX_READ_BYTES } from "../constants.js";
import { decodeUtf8, formatOutput } from "../output.js";
import { runProcess, runProcessLines } from "../process.js";
import { recordStats } from "../stats.js";
import { assertPathAllowed, formatTruncationReason, invalidParams, omission, relativePath, savingsMeta, toolTextResult, truncationMeta, validateInteger, withResponseMeta } from "./shared.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".pi", ".opencode", ".cache"]);
const INVENTORY_SKIP_DIRS = new Set([
  ...SKIP_DIRS,
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "out",
  "target",
  "tmp",
  "temp",
  "__pycache__",
]);
const GIT_CHECK_IGNORE_CHUNK_SIZE = 100;

export async function discoverTool(args) {
  const { mode = "summary" } = args ?? {};
  if (!["summary", "files", "tree", "outline", "inventory"].includes(mode)) {
    invalidParams("discover mode must be \"summary\", \"files\", \"tree\", \"outline\", or \"inventory\"");
  }

  if (mode === "summary") return await summaryMode(args);
  if (mode === "files") return await filesMode(args);
  if (mode === "tree") return await treeMode(args);
  if (mode === "inventory") return await inventoryMode(args);
  return await outlineMode(args);
}

async function filesMode(args) {
  const { path: inputPath = ".", include, maxFiles = 500, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  if (include !== undefined && typeof include !== "string") invalidParams("discover include must be a string when provided");
  const fileLimit = validateInteger(maxFiles, "discover maxFiles", 1, 5000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  await assertPathAllowed(inputPath, "discover");

  const started = Date.now();
  let matcher;
  try {
    matcher = include ? new RegExp(include) : undefined;
  } catch {
    invalidParams("discover include must be a valid regular expression");
  }
  const { files, limited } = await listFiles(inputPath, matcher, fileLimit);
  const filtered = matcher && !limited ? files.filter((file) => matcher.test(file)) : files;
  const shown = filtered.slice(0, fileLimit);
  const text = limited
    ? [...shown, omission("files")].join("\n")
    : filtered.length > shown.length
    ? [...shown, omission("files", filtered.length - shown.length)].join("\n")
    : shown.join("\n") || "(no files)";
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const truncated = limited || filtered.length > shown.length || formatted.truncated;
  const meta = withResponseMeta({
    mode: "files",
    path: path.resolve(inputPath),
    relativePath: relativePath(inputPath),
    totalFiles: limited ? undefined : filtered.length,
    totalFilesKnown: !limited,
    shownFiles: shown.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, limited || filtered.length > shown.length ? "max_files" : formatTruncationReason(formatted, lineLimit, byteLimit), limited || filtered.length > shown.length ? "Increase maxFiles or narrow include/path." : "Increase maxLines/maxBytes."),
    empty: filtered.length === 0,
    emptyReason: filtered.length === 0 ? "no_files" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

async function listFiles(inputPath, matcher, maxFiles) {
  try {
    if (!matcher) {
      const git = await runProcessLines("git", ["ls-files", "--", inputPath], {
        cwd: process.cwd(),
        timeout: 30_000,
        maxLines: maxFiles + 1,
        maxBytes: MAX_READ_BYTES,
      });
      if (git.code === 0) {
        const limited = git.truncated || git.outputTooLarge || git.lines.length > maxFiles;
        return { files: git.lines.slice(0, maxFiles), limited };
      }
    } else {
      const git = await runProcess("git", ["ls-files", "--", inputPath], { cwd: process.cwd(), timeout: 30_000 });
      if (git.code === 0) return { files: git.stdout.split("\n").filter(Boolean), limited: false };
    }
  } catch {}

  const root = process.cwd();
  const start = path.resolve(inputPath);
  const stat = await fs.promises.stat(start);
  if (stat.isFile()) return { files: [path.relative(root, start).replaceAll(path.sep, "/")].filter((file) => !matcher || matcher.test(file)), limited: false };
  const state = { files: [], limited: false, matcher, limit: maxFiles + 1 };
  await walkFiles(root, start, state);
  const limited = state.limited || state.files.length > maxFiles;
  return { files: state.files.slice(0, maxFiles), limited };
}

async function walkFiles(root, current, state) {
  if (state.files.length >= state.limit) {
    state.limited = true;
    return;
  }
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (state.files.length >= state.limit) {
      state.limited = true;
      return;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, entryPath, state);
    else if (entry.isFile()) {
      const file = path.relative(root, entryPath).replaceAll(path.sep, "/");
      if (!state.matcher || state.matcher.test(file)) state.files.push(file);
    }
  }
}

async function inventoryMode(args) {
  const { path: inputPath = ".", include, exclude, maxDepth = 5, maxFiles = 500, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  if (include !== undefined && typeof include !== "string") invalidParams("discover include must be a string when provided");
  if (exclude !== undefined && typeof exclude !== "string") invalidParams("discover exclude must be a string when provided");
  const depthLimit = validateInteger(maxDepth, "discover maxDepth", 1, 10);
  const fileLimit = validateInteger(maxFiles, "discover maxFiles", 1, 5000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  await assertPathAllowed(inputPath, "discover");

  const includeMatcher = compileInventoryPattern(include, "include");
  const excludeMatcher = compileInventoryPattern(exclude, "exclude");
  const started = Date.now();
  const root = path.resolve(inputPath);
  const state = {
    files: [],
    byTopLevel: new Map(),
    byExtension: new Map(),
    scannedFiles: 0,
    skippedDirs: new Set(),
    depthLimited: false,
    limited: false,
    limit: fileLimit + 1,
    includeMatcher,
    excludeMatcher,
  };

  const stat = await fs.promises.stat(root);
  if (stat.isFile()) {
    addInventoryFile(path.dirname(root), root, state);
  } else {
    await walkInventory(root, root, 0, depthLimit, state);
  }

  const shownFiles = state.files.slice(0, fileLimit);
  const totalKnown = !state.limited;
  const lines = [
    `Root: ${relativePath(root)}`,
    `Files: ${totalKnown ? state.files.length : `${shownFiles.length}+`} matched${state.scannedFiles !== state.files.length ? ` (${state.scannedFiles} scanned)` : ""}`,
  ];

  if (state.skippedDirs.size > 0) lines.push(`Default exclusions skipped: ${[...state.skippedDirs].sort().join(", ")}`);
  lines.push("", "Top-level directories:", ...formatCountMap(state.byTopLevel, 12));
  lines.push("", "Extensions:", ...formatCountMap(state.byExtension, 12));
  lines.push("", "Sample files:", ...(shownFiles.length > 0 ? shownFiles.map((file) => `- ${file}`) : ["(no files)"]));
  if (state.limited) lines.push(omission("files"));

  const output = lines.join("\n");
  const formatted = formatOutput(output, lineLimit, byteLimit);
  const truncated = state.limited || state.depthLimited || formatted.truncated;
  const meta = withResponseMeta({
    mode: "inventory",
    root,
    relativeRoot: relativePath(root),
    totalFiles: totalKnown ? state.files.length : undefined,
    totalFilesKnown: totalKnown,
    shownFiles: shownFiles.length,
    scannedFiles: state.scannedFiles,
    countsPartial: !totalKnown,
    topLevelCounts: Object.fromEntries(state.byTopLevel),
    extensionCounts: Object.fromEntries(state.byExtension),
    skippedDirs: [...state.skippedDirs].sort(),
    depthLimited: state.depthLimited,
    include,
    exclude,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, inventoryTruncationReason(state, formatted, lineLimit, byteLimit), inventoryTruncationHint(state, formatted)),
    empty: state.files.length === 0,
    emptyReason: state.files.length === 0 ? "no_files" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

function compileInventoryPattern(pattern, label) {
  try {
    return pattern ? new RegExp(pattern) : undefined;
  } catch {
    invalidParams(`discover ${label} must be a valid regular expression`);
  }
}

async function walkInventory(root, current, depth, maxDepth, state) {
  if (state.files.length >= state.limit) {
    state.limited = true;
    return;
  }
  if (depth >= maxDepth) {
    if (await hasInventoryChildren(current)) state.depthLimited = true;
    return;
  }

  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (state.files.length >= state.limit) {
      state.limited = true;
      return;
    }
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory() && INVENTORY_SKIP_DIRS.has(entry.name)) {
      state.skippedDirs.add(entry.name);
      continue;
    }
    if (entry.isDirectory() && isInventoryExcludedDirectory(root, entryPath, state.excludeMatcher)) continue;

    if (entry.isDirectory()) await walkInventory(root, entryPath, depth + 1, maxDepth, state);
    else if (entry.isFile()) addInventoryFile(root, entryPath, state);
  }
}

function isInventoryExcludedDirectory(root, directoryPath, excludeMatcher) {
  if (!excludeMatcher) return false;
  const relative = path.relative(root, directoryPath).replaceAll(path.sep, "/");
  return excludeMatcher.test(relative) || excludeMatcher.test(`${relative}/`);
}

function addInventoryFile(root, filePath, state) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/") || path.basename(filePath);
  if (state.excludeMatcher?.test(relative)) return;
  state.scannedFiles++;
  if (state.includeMatcher && !state.includeMatcher.test(relative)) return;
  state.files.push(relative);
  incrementCount(state.byTopLevel, topLevelFor(relative));
  incrementCount(state.byExtension, extensionFor(relative));
  if (state.files.length >= state.limit) state.limited = true;
}

function topLevelFor(file) {
  const [first, ...rest] = file.split("/");
  return rest.length === 0 ? "." : first;
}

function extensionFor(file) {
  const extension = path.extname(file).toLowerCase();
  return extension || "[none]";
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function formatCountMap(map, limit) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["(none)"];
  const lines = entries.slice(0, limit).map(([name, count]) => `- ${name}: ${count}`);
  if (entries.length > limit) lines.push(omission("groups", entries.length - limit));
  return lines;
}

async function hasInventoryChildren(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() || (entry.isDirectory() && !INVENTORY_SKIP_DIRS.has(entry.name)));
  } catch {
    return false;
  }
}

function inventoryTruncationReason(state, formatted, maxLines, maxBytes) {
  if (state.limited) return "max_files";
  if (state.depthLimited) return "depth_limit";
  return formatTruncationReason(formatted, maxLines, maxBytes);
}

function inventoryTruncationHint(state, formatted) {
  if (state.limited) return "Increase maxFiles or narrow include/exclude/path.";
  if (state.depthLimited) return "Increase maxDepth.";
  if (formatted.truncated) return "Increase maxLines/maxBytes.";
  return undefined;
}

async function treeMode(args) {
  const { path: inputPath = ".", maxDepth = 3, maxEntries = 200, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  const depthLimit = validateInteger(maxDepth, "discover maxDepth", 1, 10);
  const entryLimit = validateInteger(maxEntries, "discover maxEntries", 1, 2000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  await assertPathAllowed(inputPath, "discover");

  const started = Date.now();
  const root = path.resolve(inputPath);
  const state = { entries: 0, omitted: 0, depthLimited: false };
  const lines = [relativePath(root) ?? (path.basename(root) || root)];
  await appendTree(root, "", 1, depthLimit, entryLimit, state, lines);
  if (state.omitted > 0) lines.push(omission("entries", state.omitted));

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const truncated = state.omitted > 0 || state.depthLimited || formatted.truncated;
  const meta = withResponseMeta({
    mode: "tree",
    root,
    relativeRoot: relativePath(root),
    entriesShown: state.entries,
    entriesOmitted: state.omitted,
    entriesOmittedLowerBound: state.omitted,
    entriesOmittedKnown: state.omitted === 0,
    depthLimited: state.depthLimited,
    ...truncationMeta(truncated, treeTruncationReason(state, formatted, lineLimit, byteLimit), treeTruncationHint(state, formatted)),
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

async function appendTree(directory, prefix, depth, maxDepth, maxEntries, state, lines) {
  if (depth > maxDepth || state.entries >= maxEntries) return;
  const remaining = maxEntries - state.entries;
  const { entries, omitted } = await readTreeEntries(directory, remaining);
  state.omitted += omitted;

  for (const [index, entry] of entries.entries()) {
    if (state.entries >= maxEntries) {
      state.omitted += entries.length - index;
      return;
    }
    const last = omitted === 0 && index === entries.length - 1;
    lines.push(`${prefix}${last ? "└──" : "├──"} ${entry.name}${entry.isDirectory() ? "/" : ""}`);
    state.entries++;
    if (entry.isDirectory()) {
      const childPrefix = `${prefix}${last ? "    " : "│   "}`;
      if (depth >= maxDepth) {
        const hasChildren = await hasVisibleTreeChildren(path.join(directory, entry.name));
        if (hasChildren) {
          state.depthLimited = true;
          lines.push(`${childPrefix}└── ${omission("children beyond maxDepth")}`);
        }
      } else {
        await appendTree(path.join(directory, entry.name), childPrefix, depth + 1, maxDepth, maxEntries, state, lines);
      }
    }
  }
}

function treeTruncationReason(state, formatted, maxLines, maxBytes) {
  if (state.omitted > 0) return "max_entries";
  if (state.depthLimited) return "depth_limit";
  return formatTruncationReason(formatted, maxLines, maxBytes);
}

function treeTruncationHint(state, formatted) {
  if (state.omitted > 0) return "Increase maxEntries or pass a narrower path.";
  if (state.depthLimited) return "Increase maxDepth.";
  if (formatted.truncated) return "Increase maxLines/maxBytes.";
  return undefined;
}

async function readTreeEntries(directory, maxEntries) {
  const entries = [];
  const dir = await fs.promises.opendir(directory);

  try {
    for await (const entry of dir) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      entries.push(entry);
    }
  } finally {
    await dir.close().catch(() => {});
  }

  const visibleEntries = await filterGitIgnoredEntries(directory, entries);
  visibleEntries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { entries: visibleEntries.slice(0, maxEntries), omitted: Math.max(0, visibleEntries.length - maxEntries) };
}

async function filterGitIgnoredEntries(directory, entries) {
  if (entries.length === 0) return entries;
  const candidates = entries
    .map((entry) => ({ entry, gitPath: gitPathForCheckIgnore(path.join(directory, entry.name)) }))
    .filter((candidate) => candidate.gitPath !== undefined);
  if (candidates.length === 0) return entries;

  const ignored = await gitIgnoredPaths(candidates.map((candidate) => candidate.gitPath));
  if (ignored.size === 0) return entries;

  return entries.filter((entry) => {
    const gitPath = gitPathForCheckIgnore(path.join(directory, entry.name));
    return gitPath === undefined || !ignored.has(gitPath);
  });
}

function gitPathForCheckIgnore(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.replaceAll(path.sep, "/");
}

async function gitIgnoredPaths(gitPaths) {
  const ignored = new Set();
  for (let index = 0; index < gitPaths.length; index += GIT_CHECK_IGNORE_CHUNK_SIZE) {
    const chunk = gitPaths.slice(index, index + GIT_CHECK_IGNORE_CHUNK_SIZE);
    try {
      const result = await runProcess("git", ["check-ignore", "--", ...chunk], { cwd: process.cwd(), timeout: 10_000 });
      if (result.code === 0) {
        for (const line of result.stdout.split("\n").filter(Boolean)) ignored.add(line.replaceAll(path.sep, "/"));
      } else if (result.code !== 1) {
        return ignored;
      }
    } catch {
      return ignored;
    }
  }
  return ignored;
}

async function hasVisibleTreeChildren(directory) {
  try {
    const { entries } = await readTreeEntries(directory, 1);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function summaryMode(args) {
  const { path: inputPath = ".", maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (typeof inputPath !== "string" || inputPath.trim() === "") invalidParams("discover path must be a non-empty string when provided");
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  await assertPathAllowed(inputPath, "discover");
  const started = Date.now();
  const root = path.resolve(inputPath);
  const lines = [`Project: ${relativePath(root)}`];

  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  if (packageJson) {
    lines.push(`Name: ${packageJson.name ?? "(unnamed)"}`);
    if (packageJson.version) lines.push(`Version: ${packageJson.version}`);
    if (packageJson.type) lines.push(`Module type: ${packageJson.type}`);
    if (packageJson.main) lines.push(`Entry: ${packageJson.main}`);
    if (packageJson.bin) lines.push(`Bin: ${typeof packageJson.bin === "string" ? packageJson.bin : Object.keys(packageJson.bin).join(", ")}`);
    if (packageJson.engines?.node) lines.push(`Node: ${packageJson.engines.node}`);
    if (packageJson.scripts) lines.push(`Scripts: ${Object.keys(packageJson.scripts).join(", ")}`);
    lines.push(`Dependencies: ${Object.keys(packageJson.dependencies ?? {}).length} runtime, ${Object.keys(packageJson.devDependencies ?? {}).length} dev`);
  }

  const readmeLines = await readReadmePreviewIfExists(path.join(root, "README.md"));
  if (readmeLines.length > 0) lines.push("", "README:", ...readmeLines);

  const configs = ["package.json", "tsconfig.json", "vite.config.js", "eslint.config.js", ".gitignore", "opencode.json", "opencode.jsonc"]
    .filter((name) => fs.existsSync(path.join(root, name)));
  if (configs.length > 0) lines.push("", `Config files: ${configs.join(", ")}`);

  try {
    const gitFiles = await runProcess("git", ["ls-files"], { cwd: root, timeout: 30_000 });
    if (gitFiles.code === 0) lines.push(`Tracked files: ${gitFiles.stdout.split("\n").filter(Boolean).length}`);
  } catch {}

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = withResponseMeta({ mode: "summary", root, relativeRoot: relativePath(root), totalLines: formatted.totalLines, totalBytes: formatted.totalBytes, ...savingsMeta(formatted), truncated: formatted.truncated, ...truncationMeta(formatted.truncated, formatTruncationReason(formatted, lineLimit, byteLimit), "Increase maxLines/maxBytes."), durationMs: Date.now() - started });
  await recordStats("discover", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

async function readReadmePreviewIfExists(filePath) {
  let file;
  try {
    file = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, 16 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const rawLines = decodeUtf8(buffer.subarray(0, bytesRead), { trimEnd: true }).split(/\r?\n/);
    const title = rawLines.find((line) => /^#\s+\S/.test(line.trim()));
    const paragraph = firstReadmeParagraph(rawLines);
    return [title, paragraph].filter(Boolean);
  } catch {
    return [];
  } finally {
    await file?.close().catch(() => {});
  }
}

function firstReadmeParagraph(lines) {
  const paragraph = [];
  let afterTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!afterTitle) {
      if (/^#\s+\S/.test(line)) afterTitle = true;
      continue;
    }
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("|")) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }

  return paragraph.join(" ");
}

async function readJsonIfExists(filePath) {
  try { return JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch { return undefined; }
}

async function outlineMode(args) {
  const { path: filePath, maxSymbols = 200, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  if (typeof filePath !== "string" || filePath.trim() === "") invalidParams("discover requires a non-empty path string for outline mode");
  const symbolLimit = validateInteger(maxSymbols, "discover maxSymbols", 1, 1000);
  const lineLimit = validateInteger(maxLines, "discover maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "discover maxBytes", 1024, MAX_BYTES);
  const resolved = path.resolve(filePath);
  await assertPathAllowed(resolved, "discover");
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) invalidParams(`Not a file: ${filePath}`);
  if (stat.size > MAX_READ_BYTES) invalidParams(`File is too large for outline: ${filePath}`);

  const started = Date.now();
  const text = await fs.promises.readFile(resolved, "utf8");
  const outline = extractOutline(text);
  const symbols = outline.slice(0, symbolLimit);
  const output = symbols.length > 0 ? symbols.join("\n") : "(no outline symbols found)";
  const formatted = formatOutput(output, lineLimit, byteLimit);
  const truncated = outline.length > symbols.length || formatted.truncated;
  const meta = withResponseMeta({
    mode: "outline",
    path: resolved,
    relativePath: relativePath(resolved),
    sizeBytes: stat.size,
    symbolsFound: outline.length,
    symbolsShown: symbols.length,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, outline.length > symbols.length ? "max_symbols" : formatTruncationReason(formatted, lineLimit, byteLimit), outline.length > symbols.length ? "Increase maxSymbols." : "Increase maxLines/maxBytes."),
    empty: outline.length === 0,
    emptyReason: outline.length === 0 ? "no_symbols" : undefined,
    durationMs: Date.now() - started,
  });
  await recordStats("discover", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

function extractOutline(text) {
  const importPattern = /^\s*import\s.+/;
  const topLevelPatterns = [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/,
    /^\s*(?:export\s+)?class\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/,
  ];
  const symbols = [];
  let braceDepth = 0;

  for (const [index, line] of text.split("\n").entries()) {
    const depthBeforeLine = braceDepth;
    if (importPattern.test(line) || (depthBeforeLine === 0 && topLevelPatterns.some((pattern) => pattern.test(line)))) {
      symbols.push(`${index + 1}: ${line.trim()}`);
    }
    braceDepth = Math.max(0, braceDepth + braceDelta(line));
  }
  return symbols;
}

function braceDelta(line) {
  let delta = 0;
  let quote;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") delta++;
    else if (char === "}") delta--;
  }
  return delta;
}
