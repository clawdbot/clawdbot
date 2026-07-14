import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeHostClient } from "./client.js";
import { decodeClaudeCliNodeRunParams } from "./invoke-agent-cli-claude-params.js";
import { runClaudeCliNodeCommand } from "./invoke-agent-cli-claude.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function frame(params: unknown): NodeInvokeRequestPayload {
  return {
    id: "invoke-1",
    nodeId: "node-1",
    command: "agent.cli.claude.run.v1",
    paramsJSON: JSON.stringify(params),
  };
}

function client(calls: Array<{ method: string; params: unknown }>): NodeHostClient {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return {} as T;
    },
  };
}

async function executableScript(source: string): Promise<string> {
  // realpath: macOS tmpdir is a /var -> /private/var symlink and the approval
  // plan canonicalizes argv[0]; raw mkdtemp paths pass on Linux but fail here.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-")));
  tempDirs.push(dir);
  const file = path.join(dir, "claude-test");
  await fs.writeFile(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  return file;
}

describe("Claude CLI node command", () => {
  it.each([
    { argv: ["--unknown"], error: "unsupported Claude CLI argument" },
    { argv: ["--model"], error: "requires a value" },
    { argv: ["--mcp-config", "/tmp/mcp.json"], error: "unsupported Claude CLI argument" },
    { argv: ["--plugin-dir", "/tmp/plugin"], error: "unsupported Claude CLI argument" },
    { argv: ["--allowedTools", "Bash"], error: "unsupported Claude CLI argument" },
    // Tool policy must arrive as one comma-joined value; the multi-token
    // variadic form fails closed instead of parsing partially.
    { argv: ["--disallowedTools", "Bash", "Edit"], error: "unsupported Claude CLI argument" },
    { argv: ["--append-system-prompt", "inline"], error: "unsupported Claude CLI argument" },
    {
      argv: ["-p", "--resume", "--dangerously-skip-permissions"],
      error: "requires a non-option value",
    },
    { argv: ["--permission-mode="], error: "requires a non-option value" },
    { argv: ["--permission-mode", "bypassPermissions"], error: "not allowed" },
    { argv: ["--permission-mode=bypassPermissions"], error: "not allowed" },
  ])("rejects unsafe argv $argv", async ({ argv, error }) => {
    await expect(
      decodeClaudeCliNodeRunParams(
        JSON.stringify({ argv, idleTimeoutMs: 1_000, timeoutMs: 2_000 }),
      ),
    ).rejects.toThrow(error);
  });

  it("accepts bounded Claude resume/fork args and a separate system prompt", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-cwd-"));
    tempDirs.push(cwd);
    await expect(
      decodeClaudeCliNodeRunParams(
        JSON.stringify({
          argv: [
            "-p",
            "--output-format=stream-json",
            "--permission-mode=plan",
            "--resume",
            "session-1",
            "--fork-session",
          ],
          stdin: "hello",
          systemPrompt: "private prompt",
          cwd,
          env: { NO_COLOR: "1" },
          idleTimeoutMs: 1_000,
          timeoutMs: 2_000,
        }),
      ),
    ).resolves.toMatchObject({
      cwd,
      stdin: "hello",
      systemPrompt: "private prompt",
      env: { NO_COLOR: "1" },
    });
  });

  it("rejects missing cwd and non-allowlisted environment", async () => {
    await expect(
      decodeClaudeCliNodeRunParams(
        JSON.stringify({
          argv: ["-p"],
          cwd: "/definitely/missing/openclaw-node-cwd",
          idleTimeoutMs: 1_000,
          timeoutMs: 2_000,
        }),
      ),
    ).rejects.toThrow("cwd must be an existing directory");
    await expect(
      decodeClaudeCliNodeRunParams(
        JSON.stringify({
          argv: ["-p"],
          env: { [["OPENCLAW", "GATEWAY", "TOKEN"].join("_")]: "" },
          idleTimeoutMs: 1_000,
          timeoutMs: 2_000,
        }),
      ),
    ).rejects.toThrow("environment key is not allowed");
  });

  it("requires binary availability before consulting exec approval policy", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const handleSystemRun = vi.fn();
    await handleInvoke(
      frame({ argv: ["-p"], idleTimeoutMs: 1_000, timeoutMs: 2_000 }),
      client(calls),
      { current: async () => [] },
      undefined,
      { handleSystemRun },
    );

    expect(handleSystemRun).not.toHaveBeenCalled();
    expect(calls).toContainEqual({
      method: "node.invoke.result",
      params: expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Claude CLI agent runs are unavailable" }),
      }),
    });
  });

  it("consults the system.run approval surface with a prompt-free command", async () => {
    const executable = await executableScript("process.exit(0);");
    const calls: Array<{ method: string; params: unknown }> = [];
    const handleSystemRun = vi.fn(
      async (options: {
        params: { command: string[] };
        sendNodeEvent: (client: NodeHostClient, event: string, payload: unknown) => Promise<void>;
        sendExecFinishedEvent: (params: unknown) => Promise<void>;
        sendInvokeResult: (result: unknown) => Promise<void>;
      }) => {
        expect(options.params.command).toEqual([executable, "-p", "--resume", "session-1"]);
        await options.sendNodeEvent(client(calls), "exec.denied", {});
        await options.sendExecFinishedEvent({});
        await options.sendInvokeResult({
          ok: false,
          error: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
        });
      },
    );
    await handleInvoke(
      frame({
        argv: ["-p", "--resume", "session-1"],
        systemPrompt: "private prompt",
        idleTimeoutMs: 1_000,
        timeoutMs: 2_000,
      }),
      client(calls),
      { current: async () => [] },
      undefined,
      { claudePath: executable, handleSystemRun: handleSystemRun as never },
    );

    expect(handleSystemRun).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.method === "node.event")).toBe(false);
    expect(JSON.stringify(calls)).not.toContain("private prompt");
    const response = calls.find((call) => call.method === "node.invoke.result")?.params as {
      ok?: boolean;
      payloadJSON?: string;
    };
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.payloadJSON ?? "{}")).toMatchObject({
      approvalRequired: true,
      security: "allowlist",
      ask: "on-miss",
      systemRunPlan: {
        argv: [executable, "-p", "--resume", "session-1"],
      },
    });
  });

  it("streams stdin-driven stdout and cleans up a node-local system prompt file", async () => {
    const executable = await executableScript(`
const fs = require("node:fs");
const promptFlag = process.argv.indexOf("--append-system-prompt-file");
const promptPath = process.argv[promptFlag + 1];
const systemPrompt = fs.readFileSync(promptPath, "utf8");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", session_id: "node-session", result: input }) + "\\n");
  process.stderr.write("node stderr\\nprompt=" + promptPath + "\\ncontent=" + systemPrompt);
});`);
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = {
      argv: ["-p"],
      stdin: "hello from gateway",
      systemPrompt: "node system prompt",
      idleTimeoutMs: 1_000,
      timeoutMs: 5_000,
    };
    const result = await runClaudeCliNodeCommand({
      client: client(calls),
      frame: frame(request),
      request,
      argv: [executable, ...request.argv],
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: request.timeoutMs,
    });

    const progress = calls
      .filter((call) => call.method === "node.invoke.progress")
      .map((call) => (call.params as { chunk: string }).chunk)
      .join("");
    expect(progress).toContain('"session_id":"node-session"');
    expect(progress).toContain("hello from gateway");
    expect(result).toMatchObject({ exitCode: 0, success: true });
    expect(result.stderr).toContain("node stderr");
    expect(result.stderr).toContain("content=node system prompt");
    const promptPath = result.stderr.match(/^prompt=(.+)$/mu)?.[1];
    expect(promptPath).toBeTruthy();
    await expect(fs.stat(promptPath ?? "")).rejects.toThrow();
  });

  it("caps streamed output consistently with system.run", async () => {
    const executable = await executableScript(
      `let writes = 0;
function writeChunk() {
  if (writes++ < 80) {
    process.stdout.write("x".repeat(4096));
    setTimeout(writeChunk, 1);
    return;
  }
  process.stdout.write("\\n" + JSON.stringify({ type: "result", session_id: "tail-session", result: "done" }) + "\\n", () => process.stderr.write("late failure diagnostic"));
}
writeChunk();`,
    );
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = { argv: ["-p"], idleTimeoutMs: 1_000, timeoutMs: 5_000 };
    const result = await runClaudeCliNodeCommand({
      client: client(calls),
      frame: frame(request),
      request,
      argv: [executable, ...request.argv],
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: request.timeoutMs,
    });
    const progressBytes = calls
      .filter((call) => call.method === "node.invoke.progress")
      .reduce((sum, call) => sum + Buffer.byteLength((call.params as { chunk: string }).chunk), 0);

    const progress = calls
      .filter((call) => call.method === "node.invoke.progress")
      .map((call) => (call.params as { chunk: string }).chunk)
      .join("");
    // OUTPUT_CAP_BYTES + TERMINAL_EVENT_MAX_BYTES from invoke-agent-cli-claude.ts.
    expect(progressBytes).toBeLessThanOrEqual(200_000 + 1024 * 1024);
    expect(progress).toContain('"session_id":"tail-session"');
    expect(result.truncated).toBe(true);
    expect(result.stderr).toContain("late failure diagnostic");
    expect(
      calls.filter(
        (call) =>
          call.method === "node.invoke.progress" && (call.params as { chunk: string }).chunk === "",
      ).length,
    ).toBeLessThanOrEqual(2);
  });

  it("terminates an active Claude command when its invoke is cancelled", async () => {
    const executable = await executableScript(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const request = { argv: ["-p"], idleTimeoutMs: 5_000, timeoutMs: 10_000 };
    const run = runClaudeCliNodeCommand({
      client: client([]),
      frame: frame(request),
      request,
      argv: [executable, ...request.argv],
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: request.timeoutMs,
      signal: controller.signal,
    });

    controller.abort();

    await expect(run).resolves.toMatchObject({
      exitCode: 130,
      success: false,
      stderr: expect.stringContaining("cancelled"),
    });
  });

  it("does not spawn Claude when cancellation wins during approval", async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-marker-"));
    tempDirs.push(markerDir);
    const marker = path.join(markerDir, "spawned");
    const executable = await executableScript(
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`,
    );
    const controller = new AbortController();
    controller.abort();
    const request = { argv: ["-p"], idleTimeoutMs: 5_000, timeoutMs: 10_000 };

    await expect(
      runClaudeCliNodeCommand({
        client: client([]),
        frame: frame(request),
        request,
        argv: [executable, ...request.argv],
        cwd: undefined,
        env: process.env as Record<string, string>,
        timeoutMs: request.timeoutMs,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ exitCode: 130, success: false });
    await expect(fs.stat(marker)).rejects.toThrow();
  });
});
