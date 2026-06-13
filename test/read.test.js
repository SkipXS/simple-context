process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool } = await import("../src/tools/registry.js");

async function withTempFile(content, testFn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-read-test-"));
  const file = path.join(dir, "sample.txt");
  await fs.writeFile(file, content, "utf8");
  try {
    return await testFn(file, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await describe("sc-read range mode", async () => {
  await it("reports an out-of-file range as empty_range, not empty_file", async () => {
    await withTempFile("alpha\nbeta\n", async (file) => {
      const result = await callTool("sc-read", { path: file, fromLine: 50, toLine: 60 });

      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "empty_range");
      assert.equal(result._meta.returnedLines, 0);
      assert.equal(result._meta.sizeBytes, Buffer.byteLength("alpha\nbeta\n", "utf8"));
      assert.equal(result._meta.response.totalBytes, result._meta.response.returnedBytes);
      assert.match(result.content[0].text, /sample\.txt:50-60/);
    });
  });

  await it("keeps a real empty file classified as empty_file in range mode", async () => {
    await withTempFile("", async (file) => {
      const result = await callTool("sc-read", { path: file, fromLine: 1, toLine: 10 });

      assert.equal(result._meta.empty, true);
      assert.equal(result._meta.emptyReason, "empty_file");
      assert.equal(result._meta.returnedLines, 0);
      assert.equal(result._meta.response.totalBytes, result._meta.response.returnedBytes);
    });
  });

  await it("applies the effective maxBytes cap while collecting range content", async () => {
    const longLine = `${"x".repeat(200_000)}\nsecond line\n`;
    await withTempFile(longLine, async (file) => {
      const result = await callTool("sc-read", { path: file, fromLine: 1, toLine: 2, maxBytes: 1024, maxLines: 500 });
      const textBytes = Buffer.byteLength(result.content[0].text, "utf8");

      assert.ok(textBytes <= 1024, `returned ${textBytes} bytes`);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.truncation.reason, "range_limit");
      assert.equal(result._meta.response.returnedBytes, textBytes);
      assert.ok(result._meta.response.totalBytes > result._meta.response.returnedBytes);
      assert.ok(result._meta.response.savedBytes > 0);
      assert.notEqual(result._meta.response.totalBytes, result._meta.sizeBytes);
      assert.ok(result._meta.scannedBytes < result._meta.sizeBytes);
    });
  });

  await it("keeps line-numbered truncated range output and metadata internally consistent", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1} ${"🙂".repeat(20)}`).join("\n");
    await withTempFile(content, async (file) => {
      const result = await callTool("sc-read", { path: file, fromLine: 10, toLine: 80, lineNumbers: true, maxBytes: 1024, maxLines: 10 });
      const text = result.content[0].text;
      const textBytes = Buffer.byteLength(text, "utf8");

      assert.ok(textBytes <= 1024, `returned ${textBytes} bytes`);
      assert.match(text, /10: line 10/);
      assert.equal(result._meta.lineNumbers, true);
      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.rangeLimited, true);
      assert.equal(result._meta.response.returnedBytes, textBytes);
      assert.ok(result._meta.response.totalBytes > result._meta.response.returnedBytes);
      assert.ok(result._meta.response.savedBytes > 0);
    });
  });

  await it("reports saved bytes when a range is truncated by maxLines", async () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    await withTempFile(content, async (file) => {
      const result = await callTool("sc-read", { path: file, fromLine: 1, toLine: 30, maxLines: 10 });

      assert.equal(result._meta.truncated, true);
      assert.equal(result._meta.rangeLimited, true);
      assert.equal(result._meta.response.totalBytes > result._meta.response.returnedBytes, true);
      assert.ok(result._meta.response.savedBytes > 0);
    });
  });

  await it("preserves multi-file range metadata for the ranged file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-read-test-"));
    const ranged = path.join(dir, "ranged.txt");
    const other = path.join(dir, "other.txt");
    await fs.writeFile(ranged, "one\ntwo\nthree\n", "utf8");
    await fs.writeFile(other, "plain\n", "utf8");
    try {
      const result = await callTool("sc-read", { path: ranged, paths: [ranged, other], fromLine: 99, toLine: 100 });
      const rangedMeta = result._meta.files.find((fileMeta) => fileMeta.path === ranged);
      const otherMeta = result._meta.files.find((fileMeta) => fileMeta.path === other);

      assert.equal(rangedMeta.fromLine, 99);
      assert.equal(rangedMeta.returnedLines, 0);
      assert.equal(rangedMeta.truncated, false);
      assert.equal(otherMeta.fromLine, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
