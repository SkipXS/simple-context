process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools.js");

await describe("sc-search", async () => {
  await it("finds bounded text matches with metadata", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { pattern: "needle", path: ".", include: "*.txt", maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search: text/);
      assert.match(text, /a\.txt:1:alpha needle/);
      assert.match(text, /b\.txt:2:needle beta/);
      assert.equal(result._meta.totalMatches, 2);
      assert.equal(result._meta.totalMatchesKnown, true);
      assert.equal(result._meta.shownMatches, 2);
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("searches text as a fixed string when literal is true", async () => {
    await withTempProject(async (dir) => {
      await fs.writeFile(path.join(dir, "literal.txt"), "a.b exact\naxb regex-only\n", "utf8");

      const result = await callTool("sc-search", { pattern: "a.b", path: ".", include: "*.txt", literal: true, maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search: text "a\.b" in \.; include \*\.txt; literal; 1 match shown/);
      assert.match(text, /literal\.txt:1:a\.b exact/);
      assert.doesNotMatch(text, /axb regex-only/);
      assert.equal(result._meta.totalMatches, 1);
      assert.equal(result._meta.shownMatches, 1);
    });
  });

  await it("returns only matching file paths when filesOnly is true", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { pattern: "needle", path: ".", include: "*.txt", filesOnly: true, contextLines: 2, maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const lines = result.content[0].text.split(/\r?\n/);

      assert.match(lines[0], /Search files: text "needle" in \.; include \*\.txt; 2 files shown/);
      assert.ok(lines.includes("a.txt"));
      assert.ok(lines.includes("b.txt"));
      assert.doesNotMatch(result.content[0].text, /alpha needle/);
      assert.doesNotMatch(result.content[0].text, /needle beta/);
      assert.equal(result._meta.filesOnly, true);
      assert.equal(result._meta.shownFiles, 2);
      assert.equal(result._meta.totalFiles, 2);
      assert.equal(result._meta.shownMatches, 2);
    });
  });

  await it("combines literal and filesOnly with include and path filtering", async () => {
    await withTempProject(async (dir) => {
      await fs.mkdir(path.join(dir, "src"));
      await fs.writeFile(path.join(dir, "src", "one.txt"), "a.b exact\n", "utf8");
      await fs.writeFile(path.join(dir, "src", "two.txt"), "axb regex-only\n", "utf8");
      await fs.writeFile(path.join(dir, "outside.txt"), "a.b outside\n", "utf8");

      const result = await callTool("sc-search", { pattern: "a.b", path: "src", include: "*.txt", literal: true, filesOnly: true, maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search files: text "a\.b" in src; include \*\.txt; literal; 1 file shown/);
      assert.match(text, /src[/\\]one\.txt/);
      assert.doesNotMatch(text, /two\.txt/);
      assert.doesNotMatch(text, /outside\.txt/);
      assert.equal(result._meta.literal, true);
      assert.equal(result._meta.filesOnly, true);
      assert.equal(result._meta.shownFiles, 1);
    });
  });

  await it("reports no matches without treating rg exit 1 as an error", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { pattern: "missing-pattern", path: ".", include: "*.txt" });

      assert.equal(result.content[0].text, "(no matches)");
      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "no_matches");
      assert.equal(result._meta.totalMatches, 0);
    });
  });

  await it("summarizes text search in plan mode with counts and suggestions", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);
      await fs.writeFile(path.join(dir, "a.txt"), "alpha needle\nneedle again\nplain\n", "utf8");

      const result = await callTool("sc-search", { mode: "plan", pattern: "needle", path: ".", include: "*.txt", maxMatches: 5, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search plan: text "needle" in \.; include \*\.txt; 2 files summarized/);
      assert.match(text, /a\.txt: 2 matches/);
      assert.match(text, /b\.txt: 1 match/);
      assert.match(text, /Suggestions:/);
      assert.match(text, /literal:true/);
      assert.doesNotMatch(text, /alpha needle/);
      assert.equal(result._meta.mode, "plan");
      assert.equal(result._meta.totalFiles, 2);
      assert.equal(result._meta.totalMatches, 3);
      assert.equal(result._meta.totalMatchesKnown, true);
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("dispatches sc-search-plan as focused plan-mode text search", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);
      await fs.writeFile(path.join(dir, "a.txt"), "alpha needle\nneedle again\nplain\n", "utf8");
      const args = { pattern: "needle", path: ".", include: "*.txt", maxMatches: 5, maxLines: 80, maxBytes: 8192 };

      const focused = await callTool("sc-search-plan", args);
      const legacy = await callTool("sc-search", { mode: "plan", ...args });

      assert.equal(focused.content[0].text, legacy.content[0].text);
      assert.deepEqual(withoutDynamicSearchMeta(focused._meta), withoutDynamicSearchMeta(legacy._meta));
      assert.equal(focused._meta.mode, "plan");
      assert.match(focused.content[0].text, /Search plan: text "needle" in \.; include \*\.txt; 2 files summarized/);
      assert.doesNotMatch(focused.content[0].text, /or filesOnly:true/);
      assert.match(focused.content[0].text, /use sc-search with filesOnly:true/);
    });
  });

  await it("handles no matches in plan mode with bounded guidance", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      const result = await callTool("sc-search", { mode: "plan", pattern: "missing-pattern", path: ".", include: "*.txt", maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Search plan: text "missing-pattern" in \.; include \*\.txt; 0 files summarized/);
      assert.match(text, /\(no matches\)/);
      assert.match(text, /Suggestions:/);
      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "no_matches");
      assert.equal(result._meta.totalMatches, 0);
      assert.equal(result._meta.totalFiles, 0);
    });
  });

  await it("adds literal guidance for regex errors", async () => {
    await withTempProject(async (dir) => {
      await seedSearchProject(dir);

      await assert.rejects(
        callTool("sc-search", { pattern: "[", path: ".", include: "*.txt" }),
        (error) => {
          assert.match(error.message, /regex\/search error/);
          assert.match(error.message, /literal:true/);
          assert.match(error.message, /check regex syntax/);
          assert.equal(error.status, 2);
          return true;
        },
      );
    });
  });

  await it("line-limits text matches before collecting too many results", async () => {
    await withTempProject(async (dir) => {
      await fs.writeFile(path.join(dir, "many.txt"), Array.from({ length: 20 }, (_, index) => `needle ${index}`).join("\n"), "utf8");

      const result = await callTool("sc-search", { pattern: "needle", path: ".", maxMatches: 3, maxLines: 80, maxBytes: 8192 });

      assert.match(result.content[0].text, /\[truncated: match limit/);
      assert.equal(result._meta.shownMatches, 3);
      assert.equal(result._meta.totalMatchesKnown, false);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.truncation.reason, "match_limit");
    });
  });

  await it("runs AST search through fake ast-grep JSON-stream output", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "happy", expectedGlob: "*.js", expectedLang: "javascript", expectedContext: "1" }, async () => {
        const result = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          language: "javascript",
          contextLines: 1,
          maxMatches: 5,
          maxLines: 80,
          maxBytes: 8192,
        });

        assert.match(result.content[0].text, /Search: ast "console\.log\(\$\$\$ARGS\)" in \.; include \*\.js; lang javascript; context 1; 2 matches shown/);
        assert.match(result.content[0].text, /src[/\\]one\.js:1:1: console\.log\("one"\)/);
        assert.match(result.content[0].text, /src[/\\]two\.js:3:3: console\.log\("two"\)/);
        assert.match(result.content[0].text, /> 3:   console\.log\("two"\);/);
        assert.equal(result._meta.engine, "ast");
        assert.equal(result._meta.language, "javascript");
        assert.equal(result._meta.totalMatches, 2);
        assert.equal(result._meta.totalMatchesKnown, true);
        assert.equal(result._meta.shownMatches, 2);
        assert.equal(result._meta.truncated, false);
      });
    });
  });

  await it("reports fake ast-grep non-zero failures as tool errors", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "error" }, async () => {
        await assert.rejects(
          callTool("sc-search", { engine: "ast", pattern: "console.log($$$ARGS)", path: ".", language: "javascript" }),
          (error) => {
            assert.match(error.message, /Command failed: ast-grep run --pattern/);
            assert.match(error.message, /exited with code 2/);
            assert.equal(error.status, 2);
            assert.match(error.stderr, /fake ast-grep error/);
            return true;
          },
        );
      });
    });
  });

  await it("treats malformed AST JSON-stream lines as no matches", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "malformed" }, async () => {
        const result = await callTool("sc-search", { engine: "ast", pattern: "console.log($$$ARGS)", path: ".", language: "javascript" });

        assert.equal(result.content[0].text, "(no matches)");
        assert.equal(result._meta.empty, true);
        assert.equal(result._meta.emptyReason, "no_matches");
        assert.equal(result._meta.totalMatches, 0);
        assert.equal(result._meta.totalMatchesKnown, true);
      });
    });
  });

  await it("limits AST matches and formatted output", async () => {
    await withTempProject(async (dir) => {
      await seedAstProject(dir);
      const fakeSg = await writeFakeAstGrep(dir);
      await withFakeAstGrep(fakeSg, { mode: "many" }, async () => {
        const result = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          maxMatches: 2,
          maxLines: 10,
          maxBytes: 1024,
        });

        assert.match(result.content[0].text, /\[truncated: match limit; 2 matches shown/);
        assert.equal(result._meta.shownMatches, 2);
        assert.equal(result._meta.totalMatchesKnown, false);
        assert.equal(result._meta.truncated, true);
        assert.equal(result._meta.truncation.reason, "match_limit");

        const lineLimited = await callTool("sc-search", {
          engine: "ast",
          pattern: "console.log($$$ARGS)",
          path: ".",
          include: "*.js",
          maxMatches: 20,
          maxLines: 10,
          maxBytes: 8192,
        });
        assert.match(lineLimited.content[0].text, /\[truncated: 23 lines, 0\.7 KB; showing first 3 \+ last 5/);
        assert.equal(lineLimited._meta.truncated, true);
        assert.equal(lineLimited._meta.truncation.reason, "format_lines");
      });
    });
  });
});

function withoutDynamicSearchMeta(meta) {
  const { durationMs, ...stable } = meta;
  return stable;
}

async function withTempProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-search-test-"));
  const previousCwd = process.cwd();
  const previousRgPath = process.env.SIMPLE_CONTEXT_RG_PATH;
  try {
    process.env.SIMPLE_CONTEXT_RG_PATH = await writeFakeRg(dir);
    process.chdir(dir);
    return await callback(dir);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("SIMPLE_CONTEXT_RG_PATH", previousRgPath);
    await rmWithRetries(dir);
  }
}

async function rmWithRetries(target) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function seedSearchProject(dir) {
  await fs.writeFile(path.join(dir, "a.txt"), "alpha needle\nplain\n", "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "plain\nneedle beta\n", "utf8");
  await fs.writeFile(path.join(dir, "ignored.js"), "const needle = true;\n", "utf8");
}

async function seedAstProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "one.js"), "console.log(\"one\");\n", "utf8");
  await fs.writeFile(path.join(dir, "src", "two.js"), "const value = 1;\n  console.log(\"two\");\n", "utf8");
}

async function writeFakeRg(dir) {
  const scriptPath = path.join(dir, "fake-rg.mjs");
  await fs.writeFile(scriptPath, fakeRgSource(), "utf8");

  if (process.platform === "win32") {
    const commandPath = path.join(dir, "fake-rg.cmd");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeFakeAstGrep(dir) {
  const scriptPath = path.join(dir, "fake-ast-grep.mjs");
  await fs.writeFile(scriptPath, fakeAstGrepSource(), "utf8");

  if (process.platform === "win32") {
    const commandPath = path.join(dir, "fake-ast-grep.cmd");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    return commandPath;
  }

  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function withFakeAstGrep(fakeSg, options, callback) {
  const previousPath = process.env.SIMPLE_CONTEXT_AST_GREP_PATH;
  const previousMode = process.env.SIMPLE_CONTEXT_FAKE_AST_MODE;
  const previousGlob = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_GLOB;
  const previousLang = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_LANG;
  const previousContext = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_CONTEXT;
  try {
    process.env.SIMPLE_CONTEXT_AST_GREP_PATH = fakeSg;
    process.env.SIMPLE_CONTEXT_FAKE_AST_MODE = options.mode;
    setOptionalEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_GLOB", options.expectedGlob);
    setOptionalEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_LANG", options.expectedLang);
    setOptionalEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_CONTEXT", options.expectedContext);
    return await callback();
  } finally {
    restoreEnv("SIMPLE_CONTEXT_AST_GREP_PATH", previousPath);
    restoreEnv("SIMPLE_CONTEXT_FAKE_AST_MODE", previousMode);
    restoreEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_GLOB", previousGlob);
    restoreEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_LANG", previousLang);
    restoreEnv("SIMPLE_CONTEXT_FAKE_AST_EXPECT_CONTEXT", previousContext);
  }
}

function setOptionalEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeRgSource() {
  return `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const fixed = args.includes("--fixed-strings");
const filesOnly = args.includes("--files-with-matches");
const countMatches = args.includes("--count-matches");
const include = flagValue("--glob");
const separator = flagValue("--field-match-separator") || ":";
const dash = args.indexOf("--");
const pattern = dash === -1 ? args.at(-2) : args[dash + 1];
const searchPath = dash === -1 ? args.at(-1) : args[dash + 2];

let matcher;
try {
  matcher = fixed ? undefined : new RegExp(pattern);
} catch (error) {
  console.error("regex parse error: " + error.message);
  process.exit(2);
}

const files = listFiles(path.resolve(process.cwd(), searchPath || "."));
let hadMatch = false;
for (const file of files) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  if (include && !matchesGlob(relative, include)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\\r?\\n/);
  const matches = [];
  for (let index = 0; index < lines.length; index++) {
    if (lineMatches(lines[index], pattern, fixed, matcher)) matches.push({ lineNumber: index + 1, text: lines[index] });
  }
  if (matches.length === 0) continue;
  hadMatch = true;
  if (filesOnly) console.log(relative);
  else if (countMatches) console.log(relative + ":" + matches.length);
  else for (const match of matches) console.log(relative + separator + match.lineNumber + separator + match.text);
}
process.exit(hadMatch ? 0 : 1);

function flagValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
function lineMatches(line, pattern, fixed, matcher) {
  return fixed ? line.includes(pattern) : matcher.test(line);
}
function matchesGlob(relative, glob) {
  if (glob === "*.txt") return relative.endsWith(".txt");
  if (glob.startsWith("*.")) return relative.endsWith(glob.slice(1));
  return relative === glob || relative.endsWith("/" + glob);
}
function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    })
    .sort();
}
`;
}

function fakeAstGrepSource() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("ast-grep 0.0.0-fake");
  process.exit(0);
}
if (args[0] !== "run") {
  console.error("unexpected fake ast-grep command: " + args.join(" "));
  process.exit(2);
}
const expectedGlob = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_GLOB;
if (expectedGlob && !hasFlagValue("--globs", expectedGlob)) {
  console.error("missing expected --globs " + expectedGlob + " in " + args.join(" "));
  process.exit(3);
}
const expectedLang = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_LANG;
if (expectedLang && !hasFlagValue("--lang", expectedLang)) {
  console.error("missing expected --lang " + expectedLang + " in " + args.join(" "));
  process.exit(3);
}
const expectedContext = process.env.SIMPLE_CONTEXT_FAKE_AST_EXPECT_CONTEXT;
if (expectedContext && !hasFlagValue("--context", expectedContext)) {
  console.error("missing expected --context " + expectedContext + " in " + args.join(" "));
  process.exit(3);
}
const mode = process.env.SIMPLE_CONTEXT_FAKE_AST_MODE || "happy";
if (mode === "error") {
  console.error("fake ast-grep error");
  process.exit(2);
}
if (mode === "malformed") {
  console.log("not json");
  console.log(JSON.stringify(null));
  console.log("{bad");
  process.exit(0);
}
const count = mode === "many" ? 8 : 2;
for (let index = 0; index < count; index++) console.log(JSON.stringify(match(index)));

function hasFlagValue(flag, value) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] === value;
}
function match(index) {
  const line = index === 0 ? 0 : index + 1;
  const file = index === 0 ? "src/one.js" : "src/two.js";
  const text = index === 0 ? 'console.log("one")' : 'console.log("two")';
  return {
    text,
    file,
    range: { start: { line, column: index === 0 ? 0 : 2 }, end: { line, column: 20 } },
    lines: index === 0 ? 'console.log("one");\\n' : 'const value = 1;\\n  console.log("two");\\n',
  };
}
`;
}
