// ACPX tests cover mcp proxy plugin behavior.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const proxyPath = path.resolve(bundledPluginFile("acpx", "src/runtime-internals/mcp-proxy.mjs"));

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

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
  it("hides the target MCP process window on Windows only", async () => {
    const moduleUrl = pathToFileURL(proxyPath).href;
    const { createTargetSpawnOptions } = (await import(moduleUrl)) as {
      createTargetSpawnOptions: (platform?: NodeJS.Platform) => Record<string, unknown>;
    };

    expect(createTargetSpawnOptions("win32")).toEqual({
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    expect(createTargetSpawnOptions("darwin")).not.toHaveProperty("windowsHide");
    expect(createTargetSpawnOptions("linux")).not.toHaveProperty("windowsHide");
  });

  it("injects configured MCP servers into ACP session bootstrap requests", async () => {
    const echoServerPath = await makeTempScript(
      "echo-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => process.stdout.write(line + "\n"));
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${echoServerPath}`,
      mcpServers: [
        {
          name: "canva",
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: [{ name: "CANVA_TOKEN", value: "secret" }],
        },
      ],
    });

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

    const initialize = expectDefined(lines[0], "MCP initialize message");
    const initialized = expectDefined(lines[1], "MCP initialized message");
    const prompt = expectDefined(lines[2], "MCP prompt message");

    expect(initialize.params.mcpServers).toEqual([
      {
        name: "canva",
        command: "npx",
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        env: [{ name: "CANVA_TOKEN", value: "secret" }],
      },
    ]);
    expect(initialized.params.mcpServers).toEqual(initialize.params.mcpServers);
    expect(prompt.method).toBe("session/prompt");
    expect(prompt.params.mcpServers).toBeUndefined();
  });

  it("reports target stdin pipe failures without an unhandled stream error", async () => {
    const closedStdinServerPath = await makeTempScript(
      "closed-stdin-server.cjs",
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.closeSync(0);
process.stdout.write("ready\n");
setTimeout(() => {}, 30_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${closedStdinServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("ready\n")) {
          resolve();
        }
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    await ready;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/EPIPE|write/i);
    expect(stderr).not.toContain("Unhandled 'error' event");
  });

  it("reports proxy stdout pipe failures without an unhandled stream error", async () => {
    const outputServerPath = await makeTempScript(
      "output-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
process.stderr.write("ready\n");
createInterface({ input: process.stdin }).once("line", () => {
  process.stdout.write("x".repeat(1024 * 1024));
});
setTimeout(() => {}, 30_000);
`,
    );

    const payload = encodePayload({
      targetCommand: `${process.execPath} ${outputServerPath}`,
      mcpServers: [],
    });

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stderr = "";
    const ready = new Promise<void>((resolve) => {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("ready\n")) {
          resolve();
        }
      });
    });

    await ready;
    child.stdout.destroy();
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/EPIPE|write/i);
    expect(stderr).not.toContain("Unhandled 'error' event");
  });
});
