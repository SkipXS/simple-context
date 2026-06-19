process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-git-test-"));
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

async function seedRepo(dir) {
  await fs.writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
  await execGit(["add", "tracked.txt"], dir);
  await execGit(["commit", "-m", "base commit"], dir);
}

await describe("sc-git", async () => {
  await it("exposes overview with branch, status, diffstats, and bounded untracked files", async () => {
    await withTempRepo(async (dir) => {
      await seedRepo(dir);
      await fs.writeFile(path.join(dir, "tracked.txt"), "base\nunstaged\n", "utf8");
      await fs.writeFile(path.join(dir, "staged.txt"), "staged\n", "utf8");
      await execGit(["add", "staged.txt"], dir);
      await fs.writeFile(path.join(dir, "u1.txt"), "one\n", "utf8");
      await fs.writeFile(path.join(dir, "u2.txt"), "two\n", "utf8");
      await fs.writeFile(path.join(dir, "u3.txt"), "three\n", "utf8");

      const result = await callTool("sc-git", { mode: "overview", maxFiles: 2, maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Branch:/);
      assert.match(text, /Status:/);
      assert.match(text, /tracked\.txt/);
      assert.match(text, /staged\.txt/);
      assert.match(text, /Untracked files:/);
      assert.match(text, /u1\.txt/);
      assert.match(text, /\[omitted: more untracked files\]/);
      assert.match(text, /Unstaged diffstat:/);
      assert.match(text, /Staged diffstat:/);
      assert.equal(result._meta.mode, "overview");
      assert.equal(result._meta.gitRepository, true);
      assert.equal(result._meta.untrackedShown, 2);
      assert.equal(result._meta.untrackedLimited, true);
      assert.equal(result._meta.truncated, true);
    });
  });

  await it("reports precommit readiness including diff checks and nothing-staged warning", async () => {
    await withTempRepo(async (dir) => {
      await seedRepo(dir);
      await fs.writeFile(path.join(dir, "tracked.txt"), "base \n", "utf8");
      await fs.writeFile(path.join(dir, "new.txt"), "new\n", "utf8");

      const result = await callTool("sc-git", { mode: "precommit", maxLines: 80, maxBytes: 8192 });
      const text = result.content[0].text;

      assert.match(text, /Precommit readiness:/);
      assert.match(text, /Warning: nothing staged for commit/);
      assert.match(text, /Staged files: 0/);
      assert.match(text, /Unstaged files: 1/);
      assert.match(text, /Untracked files: 1/);
      assert.match(text, /Whitespace checks:/);
      assert.match(text, /Unstaged: issues found/);
      assert.equal(result._meta.mode, "precommit");
      assert.equal(result._meta.nothingStaged, true);
      assert.equal(result._meta.stagedFiles, 0);
      assert.equal(result._meta.unstagedFiles, 1);
      assert.equal(result._meta.untrackedFiles, 1);
      assert.equal(result._meta.unstagedCheckOk, false);
    });
  });

  await it("shows bounded decorated history honoring maxCommits", async () => {
    await withTempRepo(async (dir) => {
      await seedRepo(dir);
      await fs.writeFile(path.join(dir, "tracked.txt"), "second\n", "utf8");
      await execGit(["add", "tracked.txt"], dir);
      await execGit(["commit", "-m", "second commit"], dir);

      const result = await callTool("sc-git", { mode: "history", maxCommits: 1, maxLines: 20, maxBytes: 4096 });
      const text = result.content[0].text;

      assert.match(text, /Recent history:/);
      assert.match(text, /second commit/);
      assert.doesNotMatch(text, /base commit/);
      assert.match(text, /\(HEAD/);
      assert.equal(result._meta.mode, "history");
      assert.equal(result._meta.commitsShown, 1);
    });
  });

  await it("returns a friendly response outside git repositories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-git-non-git-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      const result = await callTool("sc-git", { maxLines: 20, maxBytes: 4096 });
      assert.match(result.content[0].text, /not a git repository/i);
      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "not_git_repository");
      assert.equal(result._meta.gitRepository, false);
    } finally {
      process.chdir(previousCwd);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
