process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { callTool, tools } = await import("../src/tools.js");
const { COMMON_SCHEMA_DEFAULTS, registeredToolNamesForTest } = await import("../src/tools/registry.js");

await describe("tool registry", async () => {
  await it("exposes only prefixed public tool names with matching handlers", () => {
    const names = tools.tools.map((tool) => tool.name);

    assert.equal(names.length, 15);
    assert.ok(names.every((name) => name.startsWith("sc-")));
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual([...names].sort(), registeredToolNamesForTest().sort());
  });

  await it("keeps common advertised defaults centralized and machine-checkable", () => {
    const commonDefaultProperties = [];
    for (const tool of tools.tools) {
      for (const [propertyName, propertySchema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (propertyName === "maxLines" || propertyName === "maxBytes" || propertyName === "timeoutMs") {
          commonDefaultProperties.push([tool.name, propertyName, propertySchema]);
        }
      }
    }

    assert.ok(commonDefaultProperties.length >= tools.tools.length * 2);
    for (const [toolName, propertyName, propertySchema] of commonDefaultProperties) {
      assert.equal(typeof propertySchema.default, "number", `${toolName} ${propertyName} default is not machine-checkable`);
      assert.match(propertySchema.description, new RegExp(`Default: ${propertySchema.default}\\.`));
      if (propertyName === "maxLines") {
        assert.equal(propertySchema.minimum, 10);
        assert.equal(propertySchema.maximum, 500);
      }
      if (propertyName === "maxBytes") {
        assert.equal(propertySchema.default, COMMON_SCHEMA_DEFAULTS.maxBytes, `${toolName} maxBytes default drifted`);
        assert.equal(propertySchema.minimum, 1024);
        assert.ok(propertySchema.maximum >= propertySchema.default);
      }
      if (propertyName === "timeoutMs") {
        if (toolName === "sc-process") {
          assert.equal(propertySchema.default, 1000);
        } else {
          assert.equal(propertySchema.default, COMMON_SCHEMA_DEFAULTS.timeoutMs, `${toolName} timeoutMs default drifted`);
        }
        assert.equal(propertySchema.minimum, 100);
        assert.equal(propertySchema.maximum, 1800000);
      }
    }
  });

  await it("describes new read/search/diff schema features without drift", () => {
    const readTool = tools.tools.find((tool) => tool.name === "sc-read");
    const snippetsTool = tools.tools.find((tool) => tool.name === "sc-snippets");
    const searchTool = tools.tools.find((tool) => tool.name === "sc-search");
    const searchPlanTool = tools.tools.find((tool) => tool.name === "sc-search-plan");
    const diffTool = tools.tools.find((tool) => tool.name === "sc-diff");
    const validateTool = tools.tools.find((tool) => tool.name === "sc-validate");
    const processTool = tools.tools.find((tool) => tool.name === "sc-process");
    const gitTool = tools.tools.find((tool) => tool.name === "sc-git");
    const resolveTool = tools.tools.find((tool) => tool.name === "sc-resolve");
    const envTool = tools.tools.find((tool) => tool.name === "sc-env");

    assert.equal(readTool.inputSchema.properties.ranges.maxItems, 20);
    assert.equal(readTool.inputSchema.properties.spec.type, "string");
    assert.match(readTool.inputSchema.properties.spec.description, /file:1-80,file2:20-60/);
    assert.match(readTool.inputSchema.properties.lineNumbers.description, /path\/paths default false/);
    assert.match(readTool.inputSchema.properties.lineNumbers.description, /ranges default true/);
    assert.deepEqual(Object.keys(snippetsTool.inputSchema.properties).sort(), ["lineNumbers", "maxBytesPerFile", "maxLinesPerFile", "maxTotalBytes", "maxTotalLines", "ranges", "spec"].sort());
    assert.equal(snippetsTool.inputSchema.properties.path, undefined);
    assert.equal(snippetsTool.inputSchema.properties.paths, undefined);
    assert.equal(snippetsTool.inputSchema.properties.fromLine, undefined);
    assert.equal(snippetsTool.inputSchema.properties.toLine, undefined);
    assert.equal(snippetsTool.inputSchema.properties.ranges.maxItems, 20);
    assert.equal(snippetsTool.inputSchema.properties.ranges.items.additionalProperties, false);
    assert.equal(snippetsTool.inputSchema.properties.ranges.items.minProperties, 2);
    assert.match(snippetsTool.inputSchema.properties.ranges.description, /fromLine or toLine/);
    assert.match(snippetsTool.description, /line-range snippets/);
    assert.equal(searchTool.inputSchema.properties.literal.type, "boolean");
    assert.match(searchTool.description, /regex by default/);
    assert.match(searchTool.description, /literal:true/);
    assert.match(searchTool.description, /filesOnly:true first/);
    assert.match(searchTool.description, /sc-snippets/);
    assert.match(searchTool.inputSchema.properties.pattern.description, /Regex for text by default/);
    assert.match(searchTool.inputSchema.properties.pattern.description, /code snippets/);
    assert.equal(searchTool.inputSchema.properties.filesOnly.type, "boolean");
    assert.match(searchTool.inputSchema.properties.filesOnly.description, /broad searches/);
    assert.deepEqual(searchTool.inputSchema.properties.mode.enum, ["search", "plan"]);
    assert.match(searchPlanTool.description, /sc-snippets/);
    assert.match(searchPlanTool.description, /regex by default/);
    assert.match(searchPlanTool.inputSchema.properties.pattern.description, /regex by default/);
    assert.match(searchPlanTool.inputSchema.properties.literal.description, /code snippets/);
    assert.deepEqual(searchPlanTool.inputSchema.required, ["pattern"]);
    assert.deepEqual(Object.keys(searchPlanTool.inputSchema.properties).sort(), ["contextLines", "include", "literal", "maxBytes", "maxLines", "maxMatches", "path", "pattern"].sort());
    assert.equal(searchPlanTool.inputSchema.properties.engine, undefined);
    assert.equal(searchPlanTool.inputSchema.properties.language, undefined);
    assert.equal(searchPlanTool.inputSchema.properties.filesOnly, undefined);
    assert.equal(searchPlanTool.inputSchema.properties.mode, undefined);
    assert.deepEqual(diffTool.inputSchema.properties.mode.enum, ["diff", "status", "history", "files", "summary"]);
    assert.deepEqual(validateTool.inputSchema.properties.mode.enum, ["auto", "npm", "go", "python", "ruby", "custom"]);
    assert.equal(validateTool.inputSchema.properties.command.type, "string");
    assert.match(validateTool.inputSchema.properties.command.description, /only when mode is custom/);
    assert.match(validateTool.description, /explicit command only with mode: custom/);
    assert.deepEqual(processTool.inputSchema.properties.mode.enum, ["start", "list", "status", "logs", "stop"]);
    assert.equal(processTool.inputSchema.properties.command.type, "string");
    assert.equal(processTool.inputSchema.properties.id.type, "string");
    assert.equal(processTool.inputSchema.properties.timeoutMs.default, 1000);
    assert.match(processTool.description, /start\/stop change/);
    assert.match(processTool.description, /list\/status\/logs inspect without project writes/);
    assert.match(diffTool.description, /path-scoped git diffs/);
    const discoverTool = tools.tools.find((tool) => tool.name === "sc-discover");
    assert.deepEqual(discoverTool.inputSchema.properties.mode.enum, ["summary", "files", "tree", "outline", "inventory"]);
    assert.equal(discoverTool.inputSchema.properties.exclude.type, "string");
    assert.match(discoverTool.description, /filesystem inventory/);
    assert.match(diffTool.description, /summaries/);
    assert.deepEqual(gitTool.inputSchema.properties.mode.enum, ["overview", "precommit", "history"]);
    assert.match(gitTool.description, /workflow dashboard/);
    assert.match(gitTool.description, /precommit checks/);
    assert.equal(resolveTool.inputSchema.properties.path.type, "string");
    assert.equal(resolveTool.inputSchema.properties.root.type, "string");
    assert.equal(resolveTool.inputSchema.properties.maxMatches.maximum, 50);
    assert.deepEqual(resolveTool.inputSchema.required, ["path"]);
    assert.equal(envTool.inputSchema.properties.tools.type, "array");
    assert.equal(envTool.inputSchema.properties.tools.maxItems, 50);
    assert.match(envTool.inputSchema.properties.tools.description, /Bare command names/);
    assert.equal(envTool.inputSchema.properties.includePath.type, "boolean");
    assert.match(envTool.description, /execute PATH version commands/);
  });

  await it("keeps advertised sc-run timeout default aligned with handler behavior", async () => {
    const runSchema = tools.tools.find((tool) => tool.name === "sc-run").inputSchema.properties;
    const command = `${JSON.stringify(process.execPath)} -e "console.log('ok')"`;

    const result = await callTool("sc-run", { command });

    assert.equal(result.content[0].text.trim(), "ok");
    assert.equal(result._meta.timeoutMs, runSchema.timeoutMs.default);
  });

  await it("rejects unprefixed tool calls with a helpful migration hint", async () => {
    await assert.rejects(
      () => callTool("run", { command: "echo ok" }),
      /Unknown tool: run\. Tool names are prefixed; use sc-run\./,
    );
  });

  await it("rejects unknown arguments before executing a tool", async () => {
    await assert.rejects(
      () => callTool("sc-run", { command: "echo should-not-run", unexpected: true }),
      /Unknown argument for sc-run: unexpected/,
    );
  });

  await it("rejects schema type, range, enum, and required argument drift before executing tools", async () => {
    await assert.rejects(
      () => callTool("sc-run", {}),
      /Missing required argument for sc-run: command/,
    );
    await assert.rejects(
      () => callTool("sc-run", { command: "echo should-not-run", maxLines: 9 }),
      /run maxLines must be between 10 and 500/,
    );
    await assert.rejects(
      () => callTool("sc-fetch", { url: "http://example.test", cache: "no" }),
      /fetch cache must be a boolean/,
    );
    await assert.rejects(
      () => callTool("sc-diff", { mode: "patch" }),
      /diff mode must be one of: diff, status, history, files, summary/,
    );
    await assert.rejects(
      () => callTool("sc-git", { mode: "status" }),
      /git mode must be one of: overview, precommit, history/,
    );
    await assert.rejects(
      () => callTool("sc-discover", { mode: "map" }),
      /discover mode must be one of: summary, files, tree, outline, inventory/,
    );
    await assert.rejects(
      () => callTool("sc-search", { pattern: "x", mode: "preview" }),
      /search mode must be one of: search, plan/,
    );
    await assert.rejects(
      () => callTool("sc-search-plan", { pattern: "x", engine: "ast" }),
      /Unknown argument for sc-search-plan: engine/,
    );
    await assert.rejects(
      () => callTool("sc-search-plan", { pattern: "x", language: "javascript" }),
      /Unknown argument for sc-search-plan: language/,
    );
    await assert.rejects(
      () => callTool("sc-search-plan", { pattern: "x", filesOnly: true }),
      /Unknown argument for sc-search-plan: filesOnly/,
    );
    await assert.rejects(
      () => callTool("sc-search-plan", { pattern: "x", mode: "search" }),
      /Unknown argument for sc-search-plan: mode/,
    );
    await assert.rejects(
      () => callTool("sc-snippets", { path: "sample.txt" }),
      /Unknown argument for sc-snippets: path/,
    );
    await assert.rejects(
      () => callTool("sc-snippets", { paths: ["sample.txt"] }),
      /Unknown argument for sc-snippets: paths/,
    );
    await assert.rejects(
      () => callTool("sc-snippets", { spec: "sample.txt:1-1", toLine: 1 }),
      /Unknown argument for sc-snippets: toLine/,
    );
    await assert.rejects(
      () => callTool("sc-process", { mode: "restart" }),
      /process mode must be one of: start, list, status, logs, stop/,
    );
    await assert.rejects(
      () => callTool("sc-read", { paths: [] }),
      /sc-read paths must contain at least 1 item/,
    );
  });

  await it("rejects unknown prefixed tool names", async () => {
    await assert.rejects(
      () => callTool("sc-missing", {}),
      /Unknown tool: sc-missing/,
    );
  });
});
