process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools.js");

await describe("sc-discover", async () => {
  await it("summarizes package metadata and README context from the default root", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const result = await callTool("sc-discover", { mode: "summary", maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Project: \./);
      assert.match(text, /Name: demo-project/);
      assert.doesNotMatch(text, /Name: nested-project/);
      assert.match(text, /Node: >=22/);
      assert.match(text, /README:/);
      assert.equal(result._meta.mode, "summary");
      assert.equal(result._meta.root, path.resolve(dir));
      assert.equal(result._meta.relativeRoot, ".");
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("summarizes the requested path instead of always using the process cwd", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const result = await callTool("sc-discover", { mode: "summary", path: "src", maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Project: src/);
      assert.match(text, /Name: nested-project/);
      assert.doesNotMatch(text, /Name: demo-project/);
      assert.match(text, /Nested package README/);
      assert.equal(result._meta.mode, "summary");
      assert.equal(result._meta.root, path.join(dir, "src"));
      assert.equal(result._meta.relativeRoot, "src");
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("validates summary path with the same non-empty string contract as other path modes", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      await assert.rejects(
        () => callTool("sc-discover", { mode: "summary", path: "" }),
        /discover path must be a non-empty string when provided/,
      );
    });
  });

  await it("lists and trees project files with bounds metadata", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const files = await callTool("sc-discover", { mode: "files", path: ".", maxFiles: 10, maxLines: 80, maxBytes: 8192 });
      const tree = await callTool("sc-discover", { mode: "tree", path: ".", maxDepth: 2, maxEntries: 20, maxLines: 80, maxBytes: 8192 });

      assert.match(files.content[0].text, /package\.json/);
      assert.match(files.content[0].text, /src\/main\.js/);
      assert.equal(files._meta.mode, "files");
      assert.equal(files._meta.totalFilesKnown, true);
      assert.match(tree.content[0].text, /src\//);
      assert.match(tree.content[0].text, /main\.js/);
      assert.equal(tree._meta.mode, "tree");
      assert.equal(tree._meta.truncated, false);
    });
  });

  await it("inventories files with default exclusions and summary counts", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);
      await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
      await fs.mkdir(path.join(dir, ".pi", "agent-runs"), { recursive: true });
      await fs.mkdir(path.join(dir, "dist"), { recursive: true });
      await fs.mkdir(path.join(dir, ".git"), { recursive: true });
      await fs.writeFile(path.join(dir, "untracked-root.txt"), "not in git index", "utf8");
      await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "ignored", "utf8");
      await fs.writeFile(path.join(dir, ".pi", "agent-runs", "log.md"), "ignored", "utf8");
      await fs.writeFile(path.join(dir, "dist", "bundle.js"), "ignored", "utf8");

      const result = await callTool("sc-discover", { mode: "inventory", path: ".", maxDepth: 5, maxFiles: 20, maxLines: 120, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Top-level directories:/);
      assert.match(text, /- src: 3/);
      assert.match(text, /Extensions:/);
      assert.match(text, /- \.json: 2/);
      assert.match(text, /Sample files:/);
      assert.match(text, /src\/main\.js/);
      assert.match(text, /untracked-root\.txt/);
      assert.doesNotMatch(text, /index\.js/);
      assert.doesNotMatch(text, /agent-runs/);
      assert.doesNotMatch(text, /bundle\.js/);
      assert.equal(result._meta.mode, "inventory");
      assert.equal(result._meta.totalFilesKnown, true);
      assert.equal(result._meta.totalFiles, 6);
      assert.equal(result._meta.topLevelCounts.src, 3);
      assert.equal(result._meta.extensionCounts[".json"], 2);
      assert.deepEqual(result._meta.skippedDirs, [".git", ".pi", "dist", "node_modules"]);
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("honors inventory depth and include/exclude filters", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);
      await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "deep", "feature.test.js"), "test", "utf8");
      await fs.writeFile(path.join(dir, "src", "helper.test.js"), "test", "utf8");

      const shallow = await callTool("sc-discover", { mode: "inventory", path: ".", maxDepth: 2, maxFiles: 20, maxLines: 120, maxBytes: 8192 });
      assert.match(shallow.content[0].text, /src\/main\.js/);
      assert.doesNotMatch(shallow.content[0].text, /feature\.test\.js/);
      assert.equal(shallow._meta.depthLimited, true);
      assert.equal(shallow._meta.truncated, true);
      assert.equal(shallow._meta.truncation.reason, "depth_limit");

      await fs.mkdir(path.join(dir, "vendor"), { recursive: true });
      for (let index = 0; index < 5; index++) {
        await fs.writeFile(path.join(dir, "vendor", `fixture-${index}.js`), "excluded", "utf8");
      }

      const filtered = await callTool("sc-discover", { mode: "inventory", path: ".", include: "\\.js$", exclude: "^vendor$|test", maxDepth: 5, maxFiles: 20, maxLines: 120, maxBytes: 8192 });
      assert.match(filtered.content[0].text, /src\/main\.js/);
      assert.doesNotMatch(filtered.content[0].text, /helper\.test\.js/);
      assert.doesNotMatch(filtered.content[0].text, /vendor/);
      assert.equal(filtered._meta.totalFiles, 1);
      assert.equal(filtered._meta.scannedFiles, 5);
      assert.equal(filtered._meta.topLevelCounts.vendor, undefined);
      assert.equal(filtered._meta.include, "\\.js$");
      assert.equal(filtered._meta.exclude, "^vendor$|test");
    });
  });

  await it("reports bounded inventory metadata when maxFiles, maxLines, or maxBytes truncate output", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);
      for (let index = 0; index < 200; index++) {
        await fs.writeFile(path.join(dir, `file-${String(index).padStart(2, "0")}.txt`), "x", "utf8");
      }

      const fileLimited = await callTool("sc-discover", { mode: "inventory", path: ".", maxDepth: 2, maxFiles: 3, maxLines: 120, maxBytes: 8192 });
      assert.equal(fileLimited._meta.totalFilesKnown, false);
      assert.equal(fileLimited._meta.shownFiles, 3);
      assert.equal(fileLimited._meta.countsPartial, true);
      assert.equal(fileLimited._meta.truncated, true);
      assert.equal(fileLimited._meta.truncation.reason, "max_files");
      assert.match(fileLimited.content[0].text, /\[omitted: more files\]/);

      const lineLimited = await callTool("sc-discover", { mode: "inventory", path: ".", maxDepth: 2, maxFiles: 500, maxLines: 10, maxBytes: 8192 });
      assert.equal(lineLimited._meta.truncated, true);
      assert.equal(lineLimited._meta.truncation.reason, "format_lines");

      const byteLimited = await callTool("sc-discover", { mode: "inventory", path: ".", maxDepth: 2, maxFiles: 500, maxLines: 500, maxBytes: 1024 });
      assert.equal(byteLimited._meta.truncated, true);
      assert.equal(byteLimited._meta.truncation.reason, "format_bytes");
    });
  });

  await it("extracts a lightweight source outline", async () => {
    await withTempProject(async (dir) => {
      await seedProject(dir);

      const result = await callTool("sc-discover", { mode: "outline", path: path.join(dir, "src", "main.js"), maxSymbols: 10, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /function greet/);
      assert.match(text, /class Greeter/);
      assert.match(text, /const answer/);
      assert.equal(result._meta.mode, "outline");
      assert.equal(result._meta.symbolsShown, 3);
    });
  });
});

async function withTempProject(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-discover-test-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return await callback(process.cwd());
  } finally {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedProject(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "demo-project",
    version: "1.0.0",
    type: "module",
    main: "src/main.js",
    engines: { node: ">=22" },
    scripts: { test: "node --test" },
  }, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "README.md"), "# Demo Project\n\nA tiny demo for discovery tests.\n", "utf8");
  await fs.writeFile(path.join(dir, "src", "package.json"), JSON.stringify({
    name: "nested-project",
    version: "2.0.0",
    type: "module",
  }, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "src", "README.md"), "# Nested package README\n\nA nested package summary should be distinct.\n", "utf8");
  await fs.writeFile(path.join(dir, "src", "main.js"), `
export function greet(name) {
  return \`hello \${name}\`;
}

export class Greeter {}

export const answer = 42;
`, "utf8");
}
