process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { callTool, tools } = await import("../src/tools.js");

await describe("tool registry", async () => {
  await it("exposes only prefixed public tool names", () => {
    const names = tools.tools.map((tool) => tool.name);

    assert.equal(names.length, 8);
    assert.ok(names.every((name) => name.startsWith("sc-")));
    assert.equal(new Set(names).size, names.length);
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

  await it("rejects unknown prefixed tool names", async () => {
    await assert.rejects(
      () => callTool("sc-missing", {}),
      /Unknown tool: sc-missing/,
    );
  });
});
