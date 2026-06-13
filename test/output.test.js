process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const { formatOutput, normalizeMaxBytes, normalizeMaxLines, decodeUtf8 } = await import("../src/output.js");

await describe("output formatting", async () => {
  await it("normalizes line and byte limits to safe bounds", () => {
    assert.equal(normalizeMaxLines(1), 10);
    assert.equal(normalizeMaxLines(10_000), 500);
    assert.equal(normalizeMaxLines("42"), 42);
    assert.equal(normalizeMaxLines("not-a-number"), 60);

    assert.equal(normalizeMaxBytes(1), 1024);
    assert.equal(normalizeMaxBytes("2048"), 2048);
  });

  await it("returns a stable placeholder for empty output", () => {
    const formatted = formatOutput("");
    assert.equal(formatted.text, "(no output)");
    assert.equal(formatted.totalLines, 0);
    assert.equal(formatted.totalBytes, 0);
    assert.equal(formatted.truncated, false);
  });

  await it("preserves short output without truncation", () => {
    const formatted = formatOutput("alpha\nbeta", 10, 4096);
    assert.equal(formatted.text, "alpha\nbeta");
    assert.equal(formatted.totalLines, 2);
    assert.equal(formatted.truncated, false);
    assert.equal(formatted.savedBytes, 0);
  });

  await it("summarizes long output with actionable retry guidance", () => {
    const input = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const formatted = formatOutput(input, 10, 4096);

    assert.equal(formatted.truncated, true);
    assert.match(formatted.text, /^\[truncated: 30 lines,/);
    assert.match(formatted.text, /raise maxLines\/maxBytes/);
    assert.match(formatted.text, /\[omitted: 22 lines\]/);
    assert.match(formatted.text, /line 1/);
    assert.match(formatted.text, /line 30/);
  });

  await it("keeps byte-limited summaries within the requested cap", () => {
    const formatted = formatOutput("🙂".repeat(2_000), 500, 1024);

    assert.equal(formatted.truncated, true);
    assert.ok(Buffer.byteLength(formatted.text, "utf8") <= 1024);
    assert.match(formatted.text, /^\[truncated:/);
    assert.match(formatted.text, /\[omitted:/);
  });

  await it("decodes UTF-8 slices defensively at invalid boundaries", () => {
    const value = Buffer.from("🙂ok", "utf8");
    assert.equal(decodeUtf8(value.subarray(1), { trimStart: true }), "ok");
    assert.equal(decodeUtf8(value.subarray(0, 3), { trimEnd: true }), "");
  });
});
