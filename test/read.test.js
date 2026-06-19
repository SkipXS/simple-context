process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

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

await describe("sc-read previews", async () => {
  await it("numbers normal non-ranged previews when lineNumbers is true", async () => {
    await withTempFile("alpha\nbeta\ngamma\n", async (file) => {
      const result = await callTool("sc-read", { path: file, lineNumbers: true });

      assert.equal(result._meta.lineNumbers, true);
      assert.match(result.content[0].text, /^1: alpha\n2: beta\n3: gamma\n?$/);
      assert.equal(result._meta.sizeBytes, Buffer.byteLength("alpha\nbeta\ngamma\n", "utf8"));
      assert.equal(result._meta.response.truncated, false);
      assert.ok(result._meta.response.totalBytes >= result._meta.response.returnedBytes);
    });
  });
});

await describe("sc-read validation feedback", async () => {
  await it("suggests a corrected maxLines value for oversized single reads", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { path: file, maxLines: 501 }),
        /(?:sc-)?read maxLines must be between 10 and 500; set maxLines to 500 or less\. Use a smaller range or split the request/,
      );
    });
  });

  await it("suggests splitting multi-file requests when maxLinesPerFile exceeds the cap", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { paths: [file], maxLinesPerFile: 501 }),
        /(?:sc-)?read maxLinesPerFile must be between 10 and 500; set maxLinesPerFile to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });

  await it("suggests splitting multi-file requests when maxLines supplies the per-file cap", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { paths: [file], maxLines: 501 }),
        /(?:sc-)?read maxLines must be between 10 and 500; set maxLines to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });

  await it("suggests splitting range packs when maxLines supplies the per-snippet cap", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { ranges: [{ path: file, fromLine: 1, toLine: 2 }], maxLines: 501 }),
        /(?:sc-)?read maxLines must be between 10 and 500; set maxLines to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });

  await it("suggests splitting range packs when maxTotalLines exceeds the cap", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { ranges: [{ path: file, fromLine: 1, toLine: 2 }], maxTotalLines: 501 }),
        /(?:sc-)?read maxTotalLines must be between 10 and 500; set maxTotalLines to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });
});

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

await describe("sc-read compact range spec", async () => {
  await it("parses comma-separated file:from-to snippets with range line-number defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-read-test-"));
    const first = path.join(dir, "first.txt");
    const second = path.join(dir, "second.txt");
    await fs.writeFile(first, "a1\na2\na3\n", "utf8");
    await fs.writeFile(second, "b1\nb2\nb3\n", "utf8");
    try {
      const result = await callTool("sc-read", { spec: `${first}:2-3,${second}:1-1` });
      const text = result.content[0].text;

      assert.match(text, /--- .*first\.txt:2-3 ---\n2: a2\n3: a3/);
      assert.match(text, /--- .*second\.txt:1-1 ---\n1: b1/);
      assert.equal(result._meta.rangesRequested, 2);
      assert.deepEqual(result._meta.ranges.map((range) => path.basename(range.path)), ["first.txt", "second.txt"]);
      assert.equal(result._meta.ranges[0].lineNumbers, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await it("allows compact spec line numbering to be disabled", async () => {
    await withTempFile("one\ntwo\nthree\n", async (file) => {
      const result = await callTool("sc-read", { spec: `${file}:2-3`, lineNumbers: false });

      assert.match(result.content[0].text, /--- .*sample\.txt:2-3 ---\ntwo\nthree/);
      assert.doesNotMatch(result.content[0].text, /2: two/);
      assert.equal(result._meta.ranges[0].lineNumbers, false);
    });
  });

  await it("rejects malformed compact specs with actionable feedback", async () => {
    await assert.rejects(
      () => callTool("sc-read", { spec: "missing-range" }),
      /read spec item 1 must match file:from-to/,
    );

    await assert.rejects(
      () => callTool("sc-read", { spec: "file.txt:8-3" }),
      /read spec item 1 toLine must be greater than or equal to fromLine/,
    );
  });

  await it("rejects ambiguous compact specs combined with existing read inputs", async () => {
    await withTempFile("one\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { spec: `${file}:1-1`, path: file }),
        /read spec cannot be combined with path, paths, ranges, fromLine, or toLine/,
      );
    });
  });

  await it("applies existing total caps to compact spec range packs", async () => {
    await withTempFile(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), async (file) => {
      const result = await callTool("sc-read", { spec: `${file}:1-20,${file}:21-40`, maxTotalLines: 10 });

      assert.equal(result._meta.truncated, true);
      assert.match(result._meta.truncation.reason, /line/);
      assert.match(result.content[0].text, /truncated|omitted/);
    });
  });

  await it("uses pack-oriented maxLines validation feedback for compact specs", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { spec: `${file}:1-2`, maxLines: 501 }),
        /(?:sc-)?read maxLines must be between 10 and 500; set maxLines to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });
});

await describe("sc-snippets focused range alias", async () => {
  await it("reads compact spec snippets with the same range output shape", async () => {
    await withTempFile("one\ntwo\nthree\n", async (file) => {
      const result = await callTool("sc-snippets", { spec: `${file}:2-3` });

      assert.match(result.content[0].text, /--- .*sample\.txt:2-3 ---\n2: two\n3: three/);
      assert.equal(result._meta.rangesRequested, 1);
      assert.equal(result._meta.ranges[0].lineNumbers, true);
    });
  });

  await it("reads explicit range snippets and honors lineNumbers/caps", async () => {
    await withTempFile("one\ntwo\nthree\nfour\n", async (file) => {
      const result = await callTool("sc-snippets", {
        ranges: [{ path: file, fromLine: 2, toLine: 4 }],
        lineNumbers: false,
        maxLinesPerFile: 20,
        maxTotalLines: 20,
      });

      assert.match(result.content[0].text, /--- .*sample\.txt:2-4 ---\ntwo\nthree\nfour/);
      assert.doesNotMatch(result.content[0].text, /2: two/);
      assert.equal(result._meta.ranges[0].lineNumbers, false);
    });
  });

  await it("accepts focused range snippets with either fromLine or toLine", async () => {
    await withTempFile("one\ntwo\nthree\nfour\n", async (file) => {
      const result = await callTool("sc-snippets", {
        ranges: [
          { path: file, fromLine: 3 },
          { path: file, toLine: 2 },
        ],
        maxLinesPerFile: 20,
        maxTotalLines: 20,
      });

      assert.match(result.content[0].text, /--- .*sample\.txt:3-end ---\n3: three\n4: four/);
      assert.match(result.content[0].text, /--- .*sample\.txt:1-2 ---\n1: one\n2: two/);
      assert.equal(result._meta.rangesRequested, 2);
    });
  });

  await it("rejects path-only range objects because snippets must stay focused", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-snippets", { ranges: [{ path: file }] }),
        /snippets ranges\[0\] must include fromLine or toLine for a focused snippet range/,
      );
    });
  });

  await it("allows compact specs and ranges to be combined into one snippet pack", async () => {
    await withTempFile("one\ntwo\nthree\nfour\n", async (file) => {
      const result = await callTool("sc-snippets", {
        spec: `${file}:1-1`,
        ranges: [{ path: file, fromLine: 4, toLine: 4 }],
      });

      assert.equal(result._meta.rangesRequested, 2);
      assert.match(result.content[0].text, /--- .*sample\.txt:1-1 ---\n1: one/);
      assert.match(result.content[0].text, /--- .*sample\.txt:4-4 ---\n4: four/);
    });
  });

  await it("rejects primary-file read arguments and uses pack cap feedback", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-snippets", { spec: `${file}:1-2`, path: file }),
        /Unknown argument for sc-snippets: path/,
      );
      await assert.rejects(
        () => callTool("sc-snippets", { ranges: [{ path: file, fromLine: 1, toLine: 2 }], paths: [file] }),
        /Unknown argument for sc-snippets: paths/,
      );
      await assert.rejects(
        () => callTool("sc-snippets", { spec: `${file}:1-2`, fromLine: 1 }),
        /Unknown argument for sc-snippets: fromLine/,
      );
      await assert.rejects(
        () => callTool("sc-snippets", { spec: `${file}:1-2`, maxLinesPerFile: 501 }),
        /(?:sc-)?snippets maxLinesPerFile must be between 10 and 500; set maxLinesPerFile to 500 or less\. For multi-file or multi-range packs, split the request or use smaller ranges\/per-file limits/,
      );
    });
  });
});

await describe("sc-read ranges snippet packs", async () => {
  await it("returns multiple numbered ranges from the same file", async () => {
    await withTempFile("one\ntwo\nthree\nfour\nfive\n", async (file) => {
      const result = await callTool("sc-read", {
        ranges: [
          { path: file, fromLine: 2, toLine: 3 },
          { path: file, fromLine: 5, toLine: 5 },
        ],
      });
      const text = result.content[0].text;

      assert.match(text, /--- .*sample\.txt:2-3 ---\n2: two\n3: three/);
      assert.match(text, /--- .*sample\.txt:5-5 ---\n5: five/);
      assert.equal(result._meta.rangesRequested, 2);
      assert.equal(result._meta.ranges.length, 2);
      assert.equal(result._meta.ranges[0].lineNumbers, true);
    });
  });

  await it("returns ranges across files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-read-test-"));
    const first = path.join(dir, "first.txt");
    const second = path.join(dir, "second.txt");
    await fs.writeFile(first, "a1\na2\na3\n", "utf8");
    await fs.writeFile(second, "b1\nb2\nb3\n", "utf8");
    try {
      const result = await callTool("sc-read", {
        ranges: [
          { path: first, fromLine: 1, toLine: 1 },
          { path: second, fromLine: 2, toLine: 3 },
        ],
      });
      const text = result.content[0].text;

      assert.match(text, /--- .*first\.txt:1-1 ---\n1: a1/);
      assert.match(text, /--- .*second\.txt:2-3 ---\n2: b2\n3: b3/);
      assert.deepEqual(result._meta.ranges.map((range) => path.basename(range.path)), ["first.txt", "second.txt"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await it("validates invalid ranges cleanly", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      await assert.rejects(
        () => callTool("sc-read", { ranges: [{ path: file, fromLine: 3, toLine: 2 }] }),
        /toLine must be greater than or equal to fromLine/,
      );
    });
  });

  await it("preserves path-only range object compatibility for sc-read", async () => {
    await withTempFile("one\ntwo\n", async (file) => {
      const result = await callTool("sc-read", { ranges: [{ path: file }] });

      assert.match(result.content[0].text, /--- .*sample\.txt ---\n1: one\n2: two/);
      assert.equal(result._meta.rangesRequested, 1);
      assert.equal(result._meta.ranges[0].fromLine, undefined);
      assert.equal(result._meta.ranges[0].lineNumbers, true);
    });
  });

  await it("applies total caps to range packs", async () => {
    await withTempFile(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), async (file) => {
      const result = await callTool("sc-read", {
        ranges: [
          { path: file, fromLine: 1, toLine: 20 },
          { path: file, fromLine: 21, toLine: 40 },
        ],
        maxTotalLines: 10,
      });

      assert.equal(result._meta.truncated, true);
      assert.match(result._meta.truncation.reason, /line/);
      assert.match(result.content[0].text, /truncated|omitted/);
    });
  });
});
