#!/usr/bin/env node

import { createInterface } from "node:readline";
import { SERVER_NAME, SERVER_VERSION } from "./src/constants.js";
import { tools, callTool } from "./src/tools.js";
import { commandErrorData, errorData } from "./src/process.js";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function sendErrorIfRequest(hasId, id, code, message, data) {
  if (hasId) sendError(id, code, message, data);
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function rpcCode(error) {
  return Number.isInteger(error.code) ? error.code : -32000;
}

const instructions = "Use sandbox_run instead of bash/terminal for any command whose full output you don't need. "
  + "Use sandbox_read instead of cat/type/Get-Content for local files whose full content you don't need. "
  + "Use sandbox_search instead of raw rg/grep commands when you need bounded local search results. "
  + "Use sandbox_fetch instead of web_fetch/webfetch for any page you don't need raw HTML from. "
  + "Read the _meta field after each call: if truncated is true, you can re-run with higher maxLines, pre-filter, or fall back to the native tool.";

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let id;
  let hasId = false;
  try {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      sendError(null, -32700, e.message);
      return;
    }

    hasId = hasRequestId(msg);
    ({ id } = msg);
    const { method, params } = msg;

    if (method === "initialize") {
      if (hasId) {
        send({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions,
          },
        });
      }
    } else if (method === "notifications/initialized") {
      // no response needed
    } else if (method === "tools/list") {
      if (hasId) send({ jsonrpc: "2.0", id, result: tools });
    } else if (method === "tools/call") {
      try {
        const { name, arguments: args } = params ?? {};
        const result = await callTool(name, args);
        if (hasId) send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        sendErrorIfRequest(hasId, id, rpcCode(e), e.message, commandErrorData(e) ?? errorData(e));
      }
    } else {
      sendErrorIfRequest(hasId, id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    sendErrorIfRequest(hasId, id, rpcCode(e), e.message);
  }
});

process.stderr.write(`[${SERVER_NAME} v${SERVER_VERSION}] ready (stdio)\n`);
