process.env.SIMPLE_CONTEXT_LIMITER_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_LIMITER_STATS = "0";

const assert = await import("node:assert/strict");
const { describe, it } = await import("node:test");
const path = await import("node:path");
const {
  formatTruncationReason,
  omitUndefined,
  relativePath,
  savingsForText,
  toolTextResult,
  truncationMeta,
  withResponseMeta,
} = await import("../src/tools/shared.js");

await describe("shared tool helpers", async () => {
  await it("calculates savings for returned previews", () => {
    assert.deepEqual(savingsForText("abcdef", "abc"), {
      totalBytes: 6,
      returnedBytes: 3,
      savedBytes: 3,
      savedPercent: 50,
      estimatedTokensSaved: 1,
    });
  });

  await it("keeps response accounting in a compact nested object", () => {
    const meta = withResponseMeta({
      mode: "demo",
      totalLines: 10,
      totalBytes: 100,
      returnedBytes: 25,
      savedBytes: 75,
      savedPercent: 75,
      estimatedTokensSaved: 19,
      truncated: true,
    });

    assert.deepEqual(meta, {
      mode: "demo",
      truncated: true,
      response: {
        totalLines: 10,
        totalBytes: 100,
        totalBytesKnown: undefined,
        returnedBytes: 25,
        savedBytes: 75,
        savedPercent: 75,
        estimatedTokensSaved: 19,
        truncated: true,
      },
    });
  });

  await it("formats relative paths inside the project and absolute paths outside it", () => {
    const root = path.resolve("/tmp/project");
    assert.equal(relativePath(path.join(root, "src", "index.js"), root), "src/index.js");
    assert.equal(relativePath(root, root), ".");

    const outside = path.resolve("/tmp/elsewhere/file.txt");
    assert.equal(relativePath(outside, root), outside);
  });

  await it("omits undefined fields without dropping falsy values", () => {
    assert.deepEqual(omitUndefined({ a: undefined, b: false, c: 0, d: "" }), { b: false, c: 0, d: "" });
  });

  await it("maps formatter truncation state to a user-facing reason", () => {
    assert.equal(formatTruncationReason({ truncated: false, totalLines: 1, totalBytes: 1 }, 10, 1024), undefined);
    assert.equal(formatTruncationReason({ truncated: true, totalLines: 20, totalBytes: 100 }, 10, 1024), "format_lines");
    assert.equal(formatTruncationReason({ truncated: true, totalLines: 2, totalBytes: 2048 }, 10, 1024), "format_bytes");
  });

  await it("adds visible truncation/retry notices while keeping response bytes accurate", () => {
    const result = toolTextResult(
      "preview",
      {
        truncated: true,
        ...truncationMeta(true, "match_limit", "Narrow pattern or raise maxMatches."),
        response: {
          totalLines: 100,
          totalBytes: 10_000,
          returnedBytes: 7,
          savedBytes: 9_993,
          savedPercent: 100,
          estimatedTokensSaved: 2_499,
          truncated: true,
        },
      },
      4096,
    );

    assert.match(result.content[0].text, /\[truncated: match limit; narrow pattern or raise maxMatches\]/);
    assert.equal(result._meta.response.returnedBytes, Buffer.byteLength(result.content[0].text, "utf8"));
    assert.equal(result._meta.response.truncated, true);
  });
});
