process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { execFileSync } = await import("node:child_process");
const { describe, it } = await import("node:test");
const { fileURLToPath } = await import("node:url");
const { classifyCommand, summarizeArgs } = await import("../src/usage.js");
const { callTool, tools } = await import("../src/tools/registry.js");

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await describe("usage command classification", async () => {
  await it("classifies verbose diagnostic commands across common ecosystems as test-build", () => {
    const commands = [
      "dotnet test --configuration Release --no-restore --filter FullyQualifiedName~Example",
      "powershell.exe -NoProfile -Command \"Get-Process App -ErrorAction SilentlyContinue | Stop-Process -Force\"; dotnet publish App/App.csproj -c Release",
      "npm run typecheck",
      "pnpm lint",
      "cargo clippy --all-targets",
      "go test ./...",
      "python -m pytest tests/test_api.py",
      "mvn verify",
      "gradlew build",
      "vite build",
      "next lint",
      "tsc --noEmit",
      "vue-tsc --noEmit",
      "eslint src --max-warnings=0",
      "vitest run",
      "playwright test",
      "cypress run",
      "./gradlew assembleRelease",
      "./gradlew :app:assembleRelease",
      "./gradlew connectedAndroidTest",
      "./gradlew lintDebug",
      "xcodebuild test -scheme App",
      "xcodebuild archive -scheme App",
      "swift test",
      "swiftlint",
      "fastlane beta",
      "make test",
      "cmake --build build",
      "ctest --output-on-failure",
    ];

    for (const command of commands) {
      assert.equal(classifyCommand(command), "test-build", command);
    }
  });

  await it("classifies runtime log commands as infra-logs", () => {
    assert.equal(classifyCommand("adb logcat"), "infra-logs");
    assert.equal(classifyCommand("xcrun simctl spawn booted log stream --style compact"), "infra-logs");
  });

  await it("classifies dependency-oriented commands separately", () => {
    assert.equal(classifyCommand("dotnet restore"), "dependencies");
    assert.equal(classifyCommand("dotnet list package"), "dependencies");
    assert.equal(classifyCommand("npm ci"), "dependencies");
    assert.equal(classifyCommand("cargo tree"), "dependencies");
  });
});

await describe("usage argument summarization", async () => {
  await it("captures safe categorical metadata without raw sensitive values", () => {
    const summary = summarizeArgs({
      path: "src/secret-file.js",
      paths: ["src/a.js", "src/b.js"],
      ranges: [{ path: "secret", fromLine: 1, toLine: 3 }],
      spec: "src/secret-file.js:1-10",
      pattern: "password=.*",
      include: "*.secret",
      url: "https://example.test/private",
      command: "echo private-token",
      mode: "history",
      engine: "text",
      literal: true,
      filesOnly: true,
      staged: false,
      stat: true,
      fromLine: 12,
      toLine: 24,
      maxLinesPerFile: 40,
      maxTotalLines: 100,
      maxBytesPerFile: 2048,
      maxTotalBytes: 4096,
      maxCommits: 7,
      maxFiles: 8,
      maxHunks: 9,
    });

    assert.deepEqual(summary, {
      path: "string",
      pathsCount: 2,
      paths: "array:2",
      rangesCount: 1,
      hasSpec: true,
      specLengthBucket: "medium",
      pattern: "string",
      patternLengthBucket: "short",
      include: "string",
      includePresent: true,
      url: "string",
      hasCommand: true,
      mode: "history",
      engine: "text",
      literal: true,
      filesOnly: true,
      staged: false,
      stat: true,
      hasFromLine: true,
      hasToLine: true,
      maxLinesPerFile: 40,
      maxTotalLines: 100,
      maxBytesPerFile: 2048,
      maxTotalBytes: 4096,
      maxCommits: 7,
      maxFiles: 8,
      maxHunks: 9,
    });
    assert.doesNotMatch(JSON.stringify(summary), /secret-file|password|private-token|example\.test/);
  });
});

await describe("usage cross-project reports", async () => {
  await it("schema accepts optional project and callTool validates it", async () => {
    const schema = tools.tools.find((tool) => tool.name === "sc-usage")?.inputSchema;
    assert.equal(schema?.properties?.project?.type, "string");

    await assert.rejects(
      callTool("sc-usage", { mode: "report", project: 123 }),
      /usage project must be a string/,
    );
  });

  await it("project:'all' report and guidance include multiple projects and project overview", () => {
    const fixture = createUsageFixture();
    const report = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "report", project: "all" } });
    assert.match(report.text, /Usage summary for all projects/);
    assert.match(report.text, /Events analyzed: 6 \(6 across all projects, 6 read\)/);
    assert.doesNotMatch(report.text, /6 for this project/);
    assert.match(report.text, /Project overview:/);
    assert.match(report.text, new RegExp(escapeRegExp(fixture.projectA)));
    assert.match(report.text, new RegExp(escapeRegExp(fixture.projectB)));
    assert.match(report.text, /Top returned-byte calls:/);
    assert.match(report.text, /Failures by tool\/exitCode\/errorCode:/);

    const guidance = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "guidance", project: "all" } });
    assert.match(guidance.text, /Usage guidance for all projects/);
    assert.match(guidance.text, /Events analyzed: 6 \(6 across all projects, 6 read\)/);
    assert.doesNotMatch(guidance.text, /6 for this project/);
    assert.match(guidance.text, /Project overview:/);
    assert.match(guidance.text, new RegExp(escapeRegExp(fixture.projectB)));
  });

  await it("default/current behavior filters to current project and exact project path selects that project", () => {
    const fixture = createUsageFixture();
    const current = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "report" } });
    assert.match(current.text, new RegExp(`Usage summary for ${escapeRegExp(fixture.projectA)}`));
    assert.equal(current.meta.eventsAnalyzed, 4);
    assert.doesNotMatch(current.text, /Project overview:/);

    const exact = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "report", project: fixture.projectB } });
    assert.match(exact.text, new RegExp(`Usage summary for ${escapeRegExp(fixture.projectB)}`));
    assert.equal(exact.meta.eventsAnalyzed, 2);

    const nestedProjectDir = path.join(fixture.projectB, "src", "nested");
    fs.mkdirSync(nestedProjectDir, { recursive: true });
    const nested = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "report", project: nestedProjectDir } });
    assert.match(nested.text, new RegExp(`Usage summary for ${escapeRegExp(fixture.projectB)}`));
    assert.equal(nested.meta.eventsAnalyzed, 2);
  });

  await it("legacy non-path project IDs match exact usage entries", () => {
    const fixture = createUsageFixture();
    const legacyId = "legacy-project-id";
    const events = [event({ project: legacyId, tool: "run", commandKind: "other", returnedBytes: 100 })];
    const report = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events, args: { mode: "report", project: legacyId } });
    assert.match(report.text, /Usage summary for legacy-project-id/);
    assert.equal(report.meta.eventsAnalyzed, 1);
  });

  await it("empty current project with non-empty usage log gives an actionable hint", () => {
    const fixture = createUsageFixture();
    const projectC = fs.mkdtempSync(path.join(fixture.root, "project-c-"));
    fs.writeFileSync(path.join(projectC, "package.json"), "{}\n");

    const report = runUsageChild({ home: fixture.home, cwd: projectC, events: fixture.events, args: { mode: "report" } });
    assert.match(report.text, /No usage events found for this project/);
    assert.match(report.text, /increasing maxEvents/);
    assert.match(report.text, /project:"all"/);
    assert.doesNotMatch(report.text, /No usage events found yet/);
  });

  await it("guidance includes top truncation contributors when truncation data exists", () => {
    const fixture = createUsageFixture();
    const guidance = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "guidance" } });
    assert.match(guidance.text, /Top truncation contributors:/);
    assert.match(guidance.text, /sc-run: 1 truncated, 12\.7 KB returned/);
  });

  await it("recommends literal:true or regex validation for search exitCode 2", () => {
    const fixture = createUsageFixture();
    const guidance = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events: fixture.events, args: { mode: "guidance" } });
    assert.match(guidance.text, /sc-search literal:true/);
    assert.match(guidance.text, /use literal:true for plain strings or validate regex syntax/i);
  });

  await it("recommends search-plan/filesOnly then snippets for high search truncation", () => {
    const fixture = createUsageFixture();
    const events = [
      event({ project: fixture.projectA, tool: "search", returnedBytes: 11000, truncated: true, args: { mode: "search", engine: "text", filesOnly: false, literal: false, patternLengthBucket: "medium" } }),
      event({ project: fixture.projectA, tool: "search", returnedBytes: 12000, truncated: true, args: { mode: "search", engine: "text", filesOnly: false, literal: false, patternLengthBucket: "medium" } }),
      event({ project: fixture.projectA, tool: "search", returnedBytes: 13000, truncated: true, args: { mode: "search", engine: "text", filesOnly: false, literal: false, patternLengthBucket: "medium" } }),
    ];

    const guidance = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events, args: { mode: "guidance" } });
    assert.match(guidance.text, /sc-search-plan or sc-search filesOnly:true/);
    assert.match(guidance.text, /then use sc-snippets on selected ranges/i);
    assert.match(guidance.text, /Truncation patterns:/);
    assert.match(guidance.text, /sc-search \(mode=search, engine=text, filesOnly=false, literal=false\): 3 truncated/);

    const report = runUsageChild({ home: fixture.home, cwd: fixture.projectA, events, args: { mode: "report" } });
    assert.match(report.text, /Truncation patterns:/);
    assert.match(report.text, /sc-search \(mode=search, engine=text, filesOnly=false, literal=false\): 3 truncated/);
  });
});

function createUsageFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-usage-test-"));
  const home = path.join(root, "home");
  const projectA = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "project-a-")));
  const projectB = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "project-b-")));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(projectA, "package.json"), "{}\n");
  fs.writeFileSync(path.join(projectB, "package.json"), "{}\n");
  const now = Date.now();
  const events = [
    event({ ts: now - 6000, project: projectA, tool: "run", commandKind: "git-history", returnedBytes: 6000, totalBytes: 12000, savedBytes: 6000 }),
    event({ ts: now - 5000, project: projectA, tool: "run", commandKind: "file-read", returnedBytes: 7000, totalBytes: 14000, savedBytes: 7000, truncated: true }),
    event({ ts: now - 4000, project: projectA, tool: "search", commandKind: "search-discovery", returnedBytes: 1000, ok: false, exitCode: 2 }),
    event({ ts: now - 3000, project: projectA, tool: "search", commandKind: "search-discovery", returnedBytes: 900, ok: false, exitCode: 2 }),
    event({ ts: now - 2000, project: projectB, tool: "logs", commandKind: "test-build", returnedBytes: 15000, totalBytes: 30000, savedBytes: 15000, truncated: true }),
    event({ ts: now - 1000, project: projectB, tool: "diff", commandKind: "git-review", returnedBytes: 3000, totalBytes: 5000, savedBytes: 2000 }),
  ];
  return { root, home, projectA, projectB, events };
}

function event(overrides) {
  return {
    ts: Date.now(),
    project: overrides.project,
    tool: overrides.tool,
    durationMs: 10,
    ok: true,
    truncated: false,
    totalBytes: overrides.totalBytes ?? overrides.returnedBytes ?? 0,
    returnedBytes: overrides.returnedBytes ?? 0,
    savedBytes: overrides.savedBytes ?? 0,
    commandKind: overrides.commandKind,
    args: {},
    ...overrides,
  };
}

function runUsageChild({ home, cwd, events, args }) {
  const script = `
    import * as fs from "node:fs";
    import * as path from "node:path";
    fs.mkdirSync(path.join(${JSON.stringify(home)}, ".simple-context"), { recursive: true });
    fs.writeFileSync(path.join(${JSON.stringify(home)}, ".simple-context", "usage.jsonl"), ${JSON.stringify(events.map((entry) => JSON.stringify(entry)).join("\n") + "\n")});
    process.chdir(${JSON.stringify(cwd)});
    const { usageTool } = await import("./src/tools/usage.js");
    const result = await usageTool(${JSON.stringify(args)});
    console.log(JSON.stringify({ text: result.content[0].text, meta: result._meta }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SIMPLE_CONTEXT_USAGE_LOG: "1",
      SIMPLE_CONTEXT_STATS: "0",
    },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
