import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPluginFile } from "../../../../test/helpers/bundled-plugin-paths.js";

const tempDirs: string[] = [];
const proxyPath = path.resolve(bundledPluginFile("acpx", "src/runtime-internals/mcp-proxy.mjs"));

async function makeTempScript(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-mcp-proxy-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("mcp-proxy", () => {
  it("injects configured MCP servers into ACP session bootstrap requests", async () => {
    const echoServerPath = await makeTempScript(
      "echo-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => process.stdout.write(line + "\n"));
`,
    );

    const payload = Buffer.from(
      JSON.stringify({
        targetCommand: `${process.execPath} ${echoServerPath}`,
        mcpServers: [
          {
            name: "canva",
            command: "npx",
            args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
            env: [{ name: "CANVA_TOKEN", value: "secret" }],
          },
        ],
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: { cwd: process.cwd(), sessionId: "sid-1", mcpServers: [] },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: "sid-1", prompt: [{ type: "text", text: "hello" }] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });

    expect(lines[0].params.mcpServers).toEqual([
      {
        name: "canva",
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        env: [{ name: "CANVA_TOKEN", value: "secret" }],
      },
    ]);
    expect(lines[1].params.mcpServers).toEqual(lines[0].params.mcpServers);
    expect(lines[2].method).toBe("session/prompt");
    expect(lines[2].params.mcpServers).toBeUndefined();
  });
});
