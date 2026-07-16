#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./error-format.mjs";
import { splitCommandLine } from "./mcp-command-line.mjs";

function decodePayload(argv) {
  const payloadIndex = argv.indexOf("--payload");
  if (payloadIndex < 0) {
    throw new Error("Missing --payload");
  }
  const encoded = argv[payloadIndex + 1];
  if (!encoded) {
    throw new Error("Missing MCP proxy payload value");
  }
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP proxy payload");
  }
  if (typeof parsed.targetCommand !== "string" || parsed.targetCommand.trim() === "") {
    throw new Error("MCP proxy payload missing targetCommand");
  }
  const mcpServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  return {
    targetCommand: parsed.targetCommand,
    mcpServers,
  };
}

function shouldInject(method) {
  return method === "session/new" || method === "session/load" || method === "session/fork";
}

function rewriteLine(line, mcpServers) {
  if (!line.trim()) {
    return line;
  }
  try {
    const parsed = JSON.parse(line);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !shouldInject(parsed.method) ||
      !parsed.params ||
      typeof parsed.params !== "object" ||
      Array.isArray(parsed.params)
    ) {
      return line;
    }
    const next = {
      ...parsed,
      params: {
        ...parsed.params,
        mcpServers,
      },
    };
    return JSON.stringify(next);
  } catch {
    return line;
  }
}

function isMainModule() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

function main() {
  const { targetCommand, mcpServers } = decodePayload(process.argv.slice(2));
  const target = splitCommandLine(targetCommand);
  const child = spawn(target.command, target.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to create MCP proxy stdio pipes");
  }

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    child.stdin.write(`${rewriteLine(line, mcpServers)}\n`);
  });
  input.on("close", () => {
    child.stdin.end();
  });

  child.stdout.pipe(process.stdout);

  child.on("error", (error) => {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (isMainModule()) {
  main();
}
