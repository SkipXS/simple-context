import { logsResult } from "./logs.js";

export async function testSummaryTool(args) {
  const { command = "npm test", ...rest } = args ?? {};
  return await logsResult({ command, ...rest }, "context_test_summary");
}
