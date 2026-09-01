import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeAgentSdk } from "./agent-sdk.runtime.js";

const roots: string[] = [];
const sessions = new Set<CliBackendLiveSessionHandle>();

const PROTOCOL_CHILD = `
  import { createInterface } from "node:readline";
  import { writeSync } from "node:fs";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response: {},
      } });
    } else if (message.type === "user") {
      const text = message.message.content;
      if (text === "fail silently") process.exit(1);
      if (text === "fail noisily") {
        writeSync(2, "PermissionError: current turn failed\\n");
        process.exit(1);
      }
      if (text === "success with stderr") writeSync(2, "previous turn diagnostic\\n");
      send({ type: "result", subtype: "success", is_error: false, result: "ok",
        session_id: "synthetic-session", duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
      });
    }
  });
`;

afterEach(async () => {
  for (const session of sessions) {
    session.close("restart");
    await session.waitForExit();
  }
  sessions.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function contextForChild(source: string): Promise<CliBackendExecuteContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-stderr-"));
  roots.push(root);
  const command = path.join(root, "claude.mjs");
  await writeFile(command, source);
  return {
    command,
    args: [],
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
    prompt: "Synthetic subprocess diagnostic probe.",
    systemPrompt: "Synthetic subprocess diagnostic probe.",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: async () => ({ behavior: "deny", message: "No tools in this probe." }),
    requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
  };
}

async function collect(context: CliBackendExecuteContext) {
  const events: Record<string, unknown>[] = [];
  for await (const event of executeClaudeAgentSdk(context)) {
    events.push(event);
  }
  return events;
}

describe("Claude subprocess diagnostics through the real Agent SDK", () => {
  it("drains pipe-sized stderr and reports a bounded redacted fatal diagnostic", async () => {
    const secret = "sk-ant-api03-synthetic-diagnostic-credential-123456789";
    const context = await contextForChild(`
      import { writeSync } from "node:fs";
      writeSync(2, "discarded noise".repeat(100_000) + "\\n");
      writeSync(2, "Authorization: Bear");
      writeSync(2, "er ${secret}\\n");
      writeSync(2, "PermissionError: [Errno 1] Operation not permitted: '/bin/ps' 🦞");
      process.exit(1);
    `);
    const error = await collect(context).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("exited with code 1");
    expect(String(error)).toContain("PermissionError: [Errno 1]");
    expect(String(error)).toContain("'/bin/ps' 🦞");
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("discarded noise");
    expect(String(error).length).toBeLessThan(2_200);
  });

  it("preserves a silent child's exit error without inventing stderr", async () => {
    const context = await contextForChild("process.exit(1);");
    await expect(collect(context)).rejects.toThrow(/^Claude Code process exited with code 1$/);
  });

  it("masks opaque descriptor and environment credentials without copying native stdout", async () => {
    const context = await contextForChild(`
      import { readFileSync, writeSync } from "node:fs";
      writeSync(1, "native stdout must stay private\\n");
      writeSync(2, "credential: " + readFileSync(3, "utf8") + "\\n");
      writeSync(2, "environment: " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
      writeSync(2, "PermissionError: denied resource 3\\n");
      process.exit(1);
    `);
    const credential = "opaque-descriptor-fixture-value";
    const grant = "opaque-mcp-fixture-value";
    context.env.OPENCLAW_MCP_TOKEN = grant;
    context.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3";
    const buffers: Buffer[] = [];
    const running = (async () => {
      for await (const _event of executeClaudeAgentSdk(context, {
        fd: 3,
        createData: () => {
          const bytes = Buffer.from(credential);
          buffers.push(bytes);
          return bytes;
        },
      })) {
        /* consume the real SDK stream */
      }
    })();
    const error = await running.catch((error: unknown) => error);
    expect(String(error)).toContain("PermissionError: denied resource 3");
    expect(String(error)).toContain("[REDACTED]");
    for (const privateText of [
      credential,
      grant,
      "native stdout must stay private",
      context.prompt,
    ]) {
      expect(String(error)).not.toContain(privateText);
    }
    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("reports failure while a descendant still holds stderr open", async () => {
    const context = await contextForChild(`
      import { spawn } from "node:child_process";
      import { writeFileSync, writeSync } from "node:fs";
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],
        { stdio: ["ignore", "ignore", 2] });
      writeFileSync("descendant.pid", String(descendant.pid));
      writeSync(2, "PermissionError: parent exited\\n");
      process.exit(1);
    `);
    try {
      await expect(collect(context)).rejects.toThrow("PermissionError: parent exited");
      const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });

  it.each(["success", "success with stderr"])("keeps %s quiet", async (prompt) => {
    const context = await contextForChild(PROTOCOL_CHILD);
    const stderr = vi.spyOn(process.stderr, "write");
    const events = await collect({ ...context, prompt });
    expect(events).toContainEqual(expect.objectContaining({ type: "result", result: "ok" }));
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["fail silently", "fail noisily"])(
    "isolates a warm successful turn's stderr from the next turn: %s",
    async (prompt) => {
      const context = await contextForChild(PROTOCOL_CHILD);
      let current: CliBackendLiveSessionHandle | undefined;
      context.liveSession = {
        fingerprint: "synthetic-process-policy",
        current: () => current,
        register: (handle) => {
          current = handle;
          sessions.add(handle);
        },
        activate: () => {},
        remove: (handle) => {
          if (current === handle) current = undefined;
        },
      };
      const stderr = vi.spyOn(process.stderr, "write");
      await expect(collect({ ...context, prompt: "success with stderr" })).resolves.toContainEqual(
        expect.objectContaining({ result: "ok" }),
      );
      expect(current?.isIdle()).toBe(true);
      const error = await collect({ ...context, prompt, useResume: true }).catch(
        (error: unknown) => error,
      );
      expect(String(error)).toContain("exited with code 1");
      expect(String(error)).not.toContain("previous turn diagnostic");
      expect(String(error).includes("PermissionError: current turn failed")).toBe(
        prompt === "fail noisily",
      );
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});
