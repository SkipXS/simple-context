#!/usr/bin/env node

process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const { tools, callTool } = await import("../src/tools.js");
const { formatOutput } = await import("../src/output.js");

const MAX_TOOLS_LIST_BYTES = 16_000;
const MAX_TOOL_DESCRIPTION_CHARS = 140;
const MAX_PROPERTY_DESCRIPTION_CHARS = 100;
const BANNED_SCHEMA_KEYWORDS = ["anyOf", "oneOf", "allOf", "const", "not"];

function findTool(name) {
  const tool = tools.tools.find((entry) => entry.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return tool;
}

function schemaKeywordPath(value, banned, path = "inputSchema") {
  if (value === null || typeof value !== "object") return undefined;
  for (const key of Object.keys(value)) {
    const currentPath = `${path}.${key}`;
    if (banned.includes(key)) return currentPath;
    const nested = schemaKeywordPath(value[key], banned, currentPath);
    if (nested) return nested;
  }
  return undefined;
}

function assertCompactSchemas() {
  const toolsListBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  assert.ok(toolsListBytes <= MAX_TOOLS_LIST_BYTES, `tools/list too large: ${toolsListBytes} > ${MAX_TOOLS_LIST_BYTES}`);
  assert.equal(tools.tools.length, 15);
  assert.equal(schemaKeywordPath(tools.tools.map((tool) => tool.inputSchema), BANNED_SCHEMA_KEYWORDS), undefined);

  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} schema must reject unknown args`);
    assert.ok(tool.description.length <= MAX_TOOL_DESCRIPTION_CHARS, `${tool.name} description too long`);

    for (const [propertyName, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      if (!property.description) continue;
      assert.ok(
        property.description.length <= MAX_PROPERTY_DESCRIPTION_CHARS,
        `${tool.name}.${propertyName} description too long: ${property.description.length}`,
      );
    }
  }
}

function assertSchemaWording() {
  for (const tool of tools.tools) {
    const maxLines = tool.inputSchema.properties?.maxLines;
    if (maxLines) assert.match(maxLines.description, /Content line cap/, `${tool.name}.maxLines should say content line cap`);
  }

  const read = findTool("sc-read");
  assert.match(read.description, /path\/fromLine\/toLine/);
  assert.match(read.inputSchema.properties.path.description, /Primary file/);
  assert.match(read.inputSchema.properties.paths.description, /Standalone list or extra files/);
  assert.match(read.inputSchema.properties.paths.description, /Ranges apply only/);

  const snippets = findTool("sc-snippets");
  assert.equal(snippets.inputSchema.properties.spec.type, "string");
  assert.equal(snippets.inputSchema.properties.path, undefined);
  assert.equal(snippets.inputSchema.properties.paths, undefined);
  assert.equal(snippets.inputSchema.properties.ranges.items.minProperties, 2);
  assert.match(snippets.inputSchema.properties.ranges.description, /fromLine or toLine/);
  assert.match(snippets.description, /line-range snippets/);

  const search = findTool("sc-search");
  assert.match(search.inputSchema.properties.pattern.description, /Regex for text/);
  assert.match(search.inputSchema.properties.include.description, /glob, not regex/);
  const searchPlan = findTool("sc-search-plan");
  assert.equal(searchPlan.inputSchema.properties.engine, undefined);
  assert.equal(searchPlan.inputSchema.properties.filesOnly, undefined);
  assert.match(searchPlan.description, /text search/);

  const discover = findTool("sc-discover");
  assert.match(discover.description, /filesystem inventory/);
  assert.match(discover.inputSchema.properties.include.description, /Regex filter/);

  assert.match(findTool("sc-run").description, /shell command/i);
  assert.match(findTool("sc-logs").description, /stdout\+stderr/);
  assert.match(findTool("sc-validate").description, /explicit command only with mode: custom/);
  assert.deepEqual(findTool("sc-validate").inputSchema.properties.mode.enum, ["auto", "npm", "go", "python", "ruby", "custom"]);
  assert.match(findTool("sc-validate").inputSchema.properties.command.description, /only when mode is custom/);
  assert.match(findTool("sc-process").description, /start\/stop change/);
  assert.match(findTool("sc-process").description, /list\/status\/logs inspect without project writes/);
  assert.match(findTool("sc-env").description, /execute PATH version commands/);
  assert.match(findTool("sc-env").inputSchema.properties.tools.description, /Bare command names/);
  assert.deepEqual(findTool("sc-process").inputSchema.properties.mode.enum, ["start", "list", "status", "logs", "stop"]);
  assert.match(findTool("sc-fetch").description, /Lightweight HTML stripping; no JS rendering/);
  assert.match(findTool("sc-diff").description, /path-scoped git diffs/);
  assert.match(findTool("sc-git").description, /workflow dashboard/);
}

async function assertReadmeWording() {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /Eight tools/);
  assert.match(readme, /Fifteen tools/);

  const documentedToolNames = new Set(
    readme
      .split("\n")
      .filter((line) => line.startsWith("| `sc-"))
      .map((line) => line.match(/^\| `(sc-[^`]+)` \|/)?.[1])
      .filter(Boolean),
  );
  const registeredToolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual([...documentedToolNames].sort(), registeredToolNames, "README tool table must mention every registered sc-* tool exactly");

  for (const toolName of registeredToolNames) {
    assert.ok(readme.includes(`### \`${toolName}\``), `README missing section for ${toolName}`);
  }

  assert.match(readme, /Use `sc-diff` for path-scoped patch\/hunk inspection/);
  assert.match(readme, /Use `sc-git` for repo workflow overview/);
  assert.match(readme, /`start` and `stop` have managed-process side effects/);
  assert.match(readme, /`list`, `status`, and `logs` do not start or stop managed processes/);
  assert.match(readme, /metadata housekeeping may update private files/);
  assert.match(readme, /`spec` string \(`file:start-end,file2:start-end`\)/);
  assert.match(readme, /each `ranges\[\]` entry must include `fromLine` or `toLine`/);
  assert.match(readme, /It is text-only: no `engine`, `language`, `filesOnly`, or `mode` arguments/);
  assert.match(readme, /`inventory` summarizes filesystem files under `path`/);
  assert.match(readme, /untracked files are included/);
  assert.doesNotMatch(readme, /`inventory` summarizes tracked files/);
  assert.match(readme, /Command-executing tools \(`sc-run`, `sc-logs`, `sc-validate`, `sc-process`, and `sc-env`\)/);
  assert.match(readme, /`sc-env` probes requested tools by executing version commands found on `PATH`/);
  assert.match(readme, /`sc-env` matches bare tool names/);
}

function assertFormatterGoldens() {
  const lineInput = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const lineLimited = formatOutput(lineInput, 10, 32768);
  assert.equal(lineLimited.text, [
    "[truncated: 20 lines, 0.1 KB; showing first 3 + last 5; raise maxLines/maxBytes]",
    "line 0",
    "line 1",
    "line 2",
    "[omitted: 12 lines]",
    "line 15",
    "line 16",
    "line 17",
    "line 18",
    "line 19",
  ].join("\n"));
  assert.equal(lineLimited.text.split("\n").length, 10);

  const byteLimited = formatOutput("x".repeat(8192), 60, 1024);
  assert.equal(byteLimited.truncated, true);
  assert.ok(Buffer.byteLength(byteLimited.text, "utf8") <= 1024);
  assert.equal((byteLimited.text.match(/\[truncated:/g) ?? []).length, 1);
  assert.equal((byteLimited.text.match(/\[omitted:/g) ?? []).length, 1);
  assert.match(byteLimited.text, /raise maxLines\/maxBytes/);
  assert.doesNotMatch(byteLimited.text, /\[retry:/);
}

function configuredShell() {
  return (process.env.SIMPLE_CONTEXT_SHELL ?? "").toLowerCase();
}

function isBashConfigured() {
  return configuredShell().includes("bash");
}

function isPowerShellConfigured() {
  const shell = configuredShell();
  return shell.includes("powershell") || shell.includes("pwsh");
}

function shellPath(value) {
  return process.platform === "win32" && isBashConfigured() ? value.replaceAll("\\", "/") : value;
}

function shellQuote(value) {
  const text = shellPath(String(value));
  if (isPowerShellConfigured()) return `'${text.replaceAll("'", "''")}'`;
  if (isBashConfigured() || process.platform !== "win32") return `'${text.replaceAll("'", "'\\''")}'`;
  return JSON.stringify(text);
}

function commandForNodeScript(scriptPath) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  return isPowerShellConfigured() ? `& ${command}` : command;
}

function normalizeDuration(text) {
  return text.replace(/in \d+ms/g, "in <ms>");
}

function normalizePath(text, filePath, replacement) {
  return text
    .replaceAll(filePath, replacement)
    .replaceAll(filePath.replaceAll("\\", "/"), replacement);
}

async function assertToolOutputGoldens() {
  let tempDir;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "simple-context-quality-"));

    const logScript = join(tempDir, "log-case.mjs");
    await writeFile(logScript, [
      "console.error('start');",
      "console.error('warn: maybe bad');",
      "console.error('Error: boom');",
      "console.error('    at test.js:1:2');",
      "process.exit(1);",
    ].join("\n"), "utf8");

    const logs = await callTool("sc-logs", {
      command: commandForNodeScript(logScript),
      maxBlocks: 5,
      contextLines: 1,
      maxBytes: 4096,
    });
    assert.equal(logs._meta.blocksFound, 1);
    assert.equal(logs._meta.blocksShown, 1);
    assert.equal(normalizeDuration(logs.content[0].text), [
      "Command exit 1 in <ms>",
      "Lines 1-4:",
      "start",
      "warn: maybe bad",
      "Error: boom",
      "    at test.js:1:2",
    ].join("\n"));

    const samplePath = join(tempDir, "sample.txt");
    await writeFile(samplePath, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const rangedRead = await callTool("sc-read", {
      path: samplePath,
      fromLine: 2,
      toLine: 3,
      lineNumbers: true,
      maxBytes: 4096,
    });
    assert.equal(normalizePath(rangedRead.content[0].text, samplePath, "<tmp>/sample.txt"), [
      "--- <tmp>/sample.txt:2-3 ---",
      "2: beta",
      "3: gamma",
    ].join("\n"));
    assert.equal(rangedRead._meta.fromLine, 2);
    assert.equal(rangedRead._meta.toLine, 3);

    const snippetsRead = await callTool("sc-snippets", {
      spec: `${samplePath}:2-3`,
      maxLinesPerFile: 20,
      maxTotalBytes: 4096,
    });
    assert.equal(normalizePath(snippetsRead.content[0].text, samplePath, "<tmp>/sample.txt"), [
      "--- <tmp>/sample.txt:2-3 ---",
      "2: beta",
      "3: gamma",
    ].join("\n"));
    assert.equal(snippetsRead._meta.rangesRequested, 1);

    const longAPath = join(tempDir, "long-a.txt");
    const longBPath = join(tempDir, "long-b.txt");
    await writeFile(longAPath, Array.from({ length: 12 }, (_, index) => `a-${index + 1}`).join("\n"), "utf8");
    await writeFile(longBPath, Array.from({ length: 12 }, (_, index) => `b-${index + 1}`).join("\n"), "utf8");
    const truncatedReadMany = await callTool("sc-read", {
      paths: [longAPath, longBPath],
      maxLinesPerFile: 20,
      maxTotalLines: 10,
      maxTotalBytes: 4096,
    });
    const normalizedReadMany = normalizePath(
      normalizePath(truncatedReadMany.content[0].text, longAPath, "<tmp>/long-a.txt"),
      longBPath,
      "<tmp>/long-b.txt",
    );
    assert.match(normalizedReadMany, /^\[truncated: multi-file total limit;/m);
    assert.doesNotMatch(normalizedReadMany, /raise maxLines\/maxBytes/);
    assert.match(normalizedReadMany, /\[retry: Split this pack; request fewer files or narrower ranges; .*maxTotalLines\/maxTotalBytes/);
    assert.equal(truncatedReadMany._meta.truncated, true);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

assertCompactSchemas();
assertSchemaWording();
await assertReadmeWording();
assertFormatterGoldens();
await assertToolOutputGoldens();

console.log("output quality checks passed");
