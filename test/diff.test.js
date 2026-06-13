process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { execFile } = await import("node:child_process");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools.js");

async function execGit(args, cwd) {
  return await new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function withTempRepo(testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-diff-test-"));
  const previousCwd = process.cwd();
  try {
    await execGit(["init"], dir);
    await execGit(["config", "user.email", "test@example.com"], dir);
    await execGit(["config", "user.name", "Test User"], dir);
    process.chdir(dir);
    return await testFn(dir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedLargeDiff(dir) {
  for (let fileIndex = 1; fileIndex <= 4; fileIndex++) {
    const lines = Array.from({ length: 80 }, (_, lineIndex) => `file${fileIndex} base ${lineIndex + 1}`);
    await fs.writeFile(path.join(dir, `file${fileIndex}.txt`), `${lines.join("\n")}\n`, "utf8");
  }
  await execGit(["add", "."], dir);
  await execGit(["commit", "-m", "base"], dir);

  for (let fileIndex = 1; fileIndex <= 4; fileIndex++) {
    const lines = Array.from({ length: 80 }, (_, lineIndex) => {
      if (lineIndex === 4 || lineIndex === 39 || lineIndex === 74) return `file${fileIndex} changed ${lineIndex + 1}`;
      return `file${fileIndex} base ${lineIndex + 1}`;
    });
    await fs.writeFile(path.join(dir, `file${fileIndex}.txt`), `${lines.join("\n")}\n`, "utf8");
  }
}

await describe("sc-diff limiting", async () => {
  await it("bounds large-ish diffs with maxFiles=1 and maxHunks=1", async () => {
    await withTempRepo(async (dir) => {
      await seedLargeDiff(dir);

      const result = await callTool("sc-diff", { maxFiles: 1, maxHunks: 1, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Diff stat:/);
      assert.match(text, /Diff hunks:/);
      assert.match(text, /diff --git a\/file1\.txt b\/file1\.txt/);
      assert.doesNotMatch(text, /diff --git a\/file2\.txt b\/file2\.txt/);
      assert.match(text, /\[omitted: more hunks\]/);
      assert.match(text, /\[omitted: more files\]/);
      assert.equal(result._meta.filesChanged, 2);
      assert.equal(result._meta.filesChangedKnown, false);
      assert.equal(result._meta.filesShown, 1);
      assert.equal(result._meta.filesLimited, true);
      assert.equal(result._meta.hunksShown, 1);
      assert.equal(result._meta.hunksLimited, true);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.response.totalBytesKnown, false);
    });
  });

  await it("preserves pathspec and staged behavior", async () => {
    await withTempRepo(async (dir) => {
      await seedLargeDiff(dir);
      await execGit(["add", "file2.txt"], dir);

      const result = await callTool("sc-diff", { path: "file2.txt", staged: true, maxFiles: 1, maxHunks: 1, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /diff --git a\/file2\.txt b\/file2\.txt/);
      assert.doesNotMatch(text, /file1\.txt/);
      assert.equal(result._meta.path, "file2.txt");
      assert.equal(result._meta.staged, true);
      assert.equal(result._meta.filesChanged, 1);
      assert.equal(result._meta.filesChangedKnown, true);
      assert.equal(result._meta.filesShown, 1);
    });
  });

  await it("bounds a very large single hunk before formatting", async () => {
    await withTempRepo(async (dir) => {
      const base = Array.from({ length: 400 }, (_, index) => `base line ${index}`).join("\n");
      await fs.writeFile(path.join(dir, "huge.txt"), `${base}\n`, "utf8");
      await execGit(["add", "."], dir);
      await execGit(["commit", "-m", "huge base"], dir);

      const changed = Array.from({ length: 400 }, (_, index) => `changed line ${index} ${"x".repeat(80)}`).join("\n");
      await fs.writeFile(path.join(dir, "huge.txt"), `${changed}\n`, "utf8");

      const result = await callTool("sc-diff", { maxFiles: 1, maxHunks: 200, maxLines: 10, maxBytes: 1024 });

      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.truncation.reason, "format_limit");
      assert.equal(result._meta.hunksChangedKnown, false);
      assert.equal(result._meta.response.totalBytesKnown, false);
      assert.ok(result._meta.response.returnedBytes <= 1024, `returned ${result._meta.response.returnedBytes} bytes`);
    });
  });

  await it("line-limits changed-file discovery before collecting many names", async () => {
    await withTempRepo(async (dir) => {
      const fileCount = 120;
      const suffix = "x".repeat(48);
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const name = `many-${String(fileIndex).padStart(3, "0")}-${suffix}.txt`;
        await fs.writeFile(path.join(dir, name), "base\n", "utf8");
      }
      await execGit(["add", "."], dir);
      await execGit(["commit", "-m", "many files"], dir);

      for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const name = `many-${String(fileIndex).padStart(3, "0")}-${suffix}.txt`;
        await fs.writeFile(path.join(dir, name), "changed\n", "utf8");
      }

      const result = await callTool("sc-diff", { maxFiles: 1, maxHunks: 1, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /diff --git a\/many-000-/);
      assert.doesNotMatch(text, /diff --git a\/many-001-/);
      assert.match(text, /\[omitted: more files\]/);
      assert.equal(result._meta.filesChanged, 2);
      assert.equal(result._meta.filesChangedKnown, false);
      assert.equal(result._meta.filesShown, 1);
      assert.equal(result._meta.filesLimited, true);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.response.totalBytesKnown, false);
    });
  });
});
