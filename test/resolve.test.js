process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool, tools } = await import("../src/tools.js");

await describe("sc-resolve", async () => {
  await it("resolves an existing file with real and project-relative paths", async () => {
    await withTempProject(async (dir) => {
      await fs.mkdir(path.join(dir, "src"));
      await fs.writeFile(path.join(dir, "src", "target.js"), "export const value = 1;\n", "utf8");

      const result = await callTool("sc-resolve", { path: "src/target.js" });
      const text = result.content[0].text;

      assert.match(text, /Resolved:/);
      assert.match(text, /Type: file/);
      assert.match(text, /Project relative: src[/\\]target\.js|Project relative: src\/target\.js/);
      assert.equal(result._meta.exists, true);
      assert.equal(result._meta.type, "file");
      assert.equal(result._meta.projectRelativePath, "src/target.js");
      assert.equal(path.normalize(result._meta.path), path.join(dir, "src", "target.js"));
      assert.equal(result._meta.truncated, false);
    });
  });

  await it("accepts Windows-style separators for relative paths", async () => {
    await withTempProject(async () => {
      await fs.mkdir(path.join("nested", "windows"), { recursive: true });
      await fs.writeFile(path.join("nested", "windows", "file.txt"), "ok\n", "utf8");

      const result = await callTool("sc-resolve", { path: "nested\\windows\\file.txt" });

      assert.equal(result._meta.exists, true);
      assert.equal(result._meta.projectRelativePath, "nested/windows/file.txt");
      assert.match(result.content[0].text, /Type: file/);
    });
  });

  await it("suggests bounded close candidates for missing paths and excludes generated directories", async () => {
    await withTempProject(async () => {
      await fs.mkdir(path.join("src", "components"), { recursive: true });
      await fs.mkdir(path.join("node_modules", "pkg"), { recursive: true });
      await fs.mkdir(path.join(".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(".pi", "agent-runs"), { recursive: true });
      await fs.mkdir("dist", { recursive: true });
      await fs.writeFile(path.join("src", "components", "Button.jsx"), "export function Button() {}\n", "utf8");
      await fs.writeFile(path.join("src", "components", "Button.test.jsx"), "test('button', () => {});\n", "utf8");
      await fs.writeFile(path.join("node_modules", "pkg", "Button.jsx"), "ignored\n", "utf8");
      await fs.writeFile(path.join(".git", "objects", "Button.jsx"), "ignored\n", "utf8");
      await fs.writeFile(path.join(".pi", "agent-runs", "Button.jsx"), "ignored\n", "utf8");
      await fs.writeFile(path.join("dist", "Button.jsx"), "ignored\n", "utf8");

      const result = await callTool("sc-resolve", { path: "src/Button.jsx", maxMatches: 1 });
      const text = result.content[0].text;

      assert.equal(result._meta.exists, false);
      assert.equal(result._meta.candidatesShown, 1);
      assert.match(text, /src\/components\/Button\.jsx|src\\components\\Button\.jsx/);
      assert.doesNotMatch(text, /node_modules/);
      assert.doesNotMatch(text, /\.git/);
      assert.doesNotMatch(text, /\.pi/);
      assert.doesNotMatch(text, /dist/);
    });
  });

  await it("uses the optional root for candidate search", async () => {
    await withTempProject(async () => {
      await fs.mkdir(path.join("packages", "one", "src"), { recursive: true });
      await fs.mkdir(path.join("packages", "two", "src"), { recursive: true });
      await fs.writeFile(path.join("packages", "one", "src", "config.json"), "{}\n", "utf8");
      await fs.writeFile(path.join("packages", "two", "src", "config.json"), "{}\n", "utf8");

      const result = await callTool("sc-resolve", { path: "missing/config.json", root: "packages/one", maxMatches: 5 });
      const text = result.content[0].text;

      assert.match(text, /src\/config\.json|src\\config\.json/);
      assert.doesNotMatch(text, /packages[/\\]two/);
      assert.equal(result._meta.exists, false);
      assert.equal(result._meta.root, path.resolve("packages/one"));
    });
  });

  await it("advertises required schema and rejects invalid roots", async () => {
    const resolveTool = tools.tools.find((tool) => tool.name === "sc-resolve");
    assert.equal(resolveTool.inputSchema.properties.path.type, "string");
    assert.equal(resolveTool.inputSchema.properties.root.type, "string");
    assert.equal(resolveTool.inputSchema.properties.maxMatches.default, 10);
    assert.deepEqual(resolveTool.inputSchema.required, ["path"]);

    await withTempProject(async () => {
      await assert.rejects(
        () => callTool("sc-resolve", { path: "missing.txt", root: "does-not-exist" }),
        /resolve root does not exist/,
      );
    });
  });
});

async function withTempProject(callback) {
  const previousCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-resolve-"));
  try {
    process.chdir(dir);
    return await callback(dir);
  } finally {
    process.chdir(previousCwd);
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
