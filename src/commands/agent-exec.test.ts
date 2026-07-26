import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../agents/auth-profiles.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand, classifyAgentExecResult, resolveAgentExecPrompt } from "./agent-exec.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime() {
  const log = vi.fn();
  const error = vi.fn();
  const runtime: RuntimeEnv = {
    log,
    error,
    exit: vi.fn(),
  };
  return { runtime, log, error };
}

function successResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: text,
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 2, total: 12 },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("agent exec prompt sources", () => {
  it("accepts a positional prompt", async () => {
    await expect(resolveAgentExecPrompt("fix it", undefined)).resolves.toBe("fix it");
  });

  it("reads a UTF-8 prompt file", async () => {
    const root = await makeTempRoot("openclaw-agent-exec-prompt-");
    const promptPath = path.join(root, "prompt.md");
    await fs.writeFile(promptPath, "\uFEFFline one\nline two", "utf8");

    await expect(resolveAgentExecPrompt(undefined, promptPath)).resolves.toBe("line one\nline two");
  });

  it("reads --message-file - from stdin", async () => {
    const stdin = Readable.from([Buffer.from("from stdin", "utf8")]);
    await expect(resolveAgentExecPrompt(undefined, "-", stdin)).resolves.toBe("from stdin");
  });
});

describe("agent exec strict result classification", () => {
  it("classifies a successful embedded result", () => {
    expect(classifyAgentExecResult(successResult())).toMatchObject({
      ok: true,
      status: "ok",
      final: "done",
    });
  });

  it("classifies model error payloads as failure", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "provider rejected request", isError: true }],
      meta: { durationMs: 10 },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "error_payload", message: "provider rejected request" },
    });
  });

  it("classifies textless error payloads as failure", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ isError: true }],
      meta: { durationMs: 10 },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "error_payload", message: "Agent run failed" },
    });
  });

  it("classifies terminal timeouts separately", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "timed out", isError: true }],
      meta: { durationMs: 600_000, aborted: true, stopReason: "timeout" },
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: "timeout",
      error: { kind: "timeout" },
    });
  });

  it("classifies exhausted explicit fallbacks as failure", () => {
    const envelope = classifyAgentExecResult(successResult("last candidate output"), true);
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "fallback_exhausted" },
    });
  });

  it("classifies projected production error payloads as failure", () => {
    const envelope = classifyAgentExecResult(
      successResult("projected error text"),
      false,
      "projected error text",
    );
    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      final: "",
      payloads: [{ text: "projected error text", isError: true }],
      error: { kind: "error_payload", message: "projected error text" },
    });
  });

  it("does not restore metadata text for a projected textless error", () => {
    const result = successResult("metadata error text");
    result.payloads = [];
    const envelope = classifyAgentExecResult(result, false, true);
    expect(envelope).toMatchObject({ ok: false, status: "error", final: "", payloads: [] });
  });

  it("projects payloads onto the stable documented fields", () => {
    const envelope = classifyAgentExecResult({
      payloads: [
        {
          text: "done",
          mediaUrl: null,
          audioAsVoice: true,
          presentation: { blocks: [] },
          channelData: { private: true },
        },
      ],
      meta: { durationMs: 10 },
    });
    expect(envelope.payloads).toEqual([{ text: "done", mediaUrl: null }]);
  });
});

describe("agent exec command composition", () => {
  it("writes plain final text to stdout when diagnostics are routed to stderr", async () => {
    const source = `
      import { agentExecCommand } from "./src/commands/agent-exec.ts";
      import { enableConsoleCapture, routeLogsToStderr } from "./src/logging.ts";
      import { defaultRuntime } from "./src/runtime.ts";

      routeLogsToStderr();
      enableConsoleCapture();
      const result = await agentExecCommand("inspect", {}, defaultRuntime, {
        runAgent: async () => ({
          payloads: [{ text: "india" }],
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId: "session-result",
              provider: "openai",
              model: "gpt-5.6-sol",
            },
          },
        }),
      });
      process.exitCode = result.exitCode;
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
      },
    );

    expect(stdout).toBe("india\n");
    expect(stderr).not.toContain("india");
  });

  it("treats invalid timeout syntax as an ordinary usage error", async () => {
    const { runtime } = createRuntime();

    const result = await agentExecCommand("inspect", { timeout: "nope", json: true }, runtime, {
      runAgent: vi.fn(async () => successResult()),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { status: "error", error: { kind: "exception" } },
    });
  });

  it("maps structured thrown timeouts to exit code 2", async () => {
    const { runtime } = createRuntime();
    const timeout = Object.assign(new Error("deadline elapsed"), { name: "TimeoutError" });

    const result = await agentExecCommand("inspect", { json: true }, runtime, {
      runAgent: vi.fn(async () => {
        throw timeout;
      }),
    });

    expect(result).toMatchObject({
      exitCode: 2,
      envelope: { status: "timeout", error: { kind: "timeout" } },
    });
  });

  it("creates and removes ephemeral state around the embedded run", async () => {
    const { runtime } = createRuntime();
    let observedStateDir = "";
    let observedConfig: unknown;
    const result = await agentExecCommand("inspect", {}, runtime, {
      runAgent: vi.fn(async () => {
        observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
        observedConfig = JSON.parse(
          await fs.readFile(process.env.OPENCLAW_CONFIG_PATH ?? "", "utf8"),
        );
        await expect(fs.stat(observedStateDir)).resolves.toBeDefined();
        return successResult();
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(observedConfig).toMatchObject({
      agents: { defaults: { skipBootstrap: true, sandbox: { mode: "off" } } },
      tools: {
        profile: "coding",
        fs: { workspaceOnly: true },
        exec: { host: "gateway", mode: "full" },
      },
    });
    await expect(fs.stat(observedStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies cleanup failures before emitting the JSON envelope", async () => {
    const { runtime, log } = createRuntime();
    let observedStateDir = "";
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await agentExecCommand("inspect", { json: true }, runtime, {
      runAgent: vi.fn(async () => {
        observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
        return successResult();
      }),
    });
    tempRoots.push(observedStateDir);

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        ok: false,
        status: "error",
        error: { kind: "exception", message: "Agent exec cleanup failed: cleanup denied" },
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      status: "error",
      error: { message: "Agent exec cleanup failed: cleanup denied" },
    });
  });

  it("threads --cwd to both workspace and tool cwd", async () => {
    const root = await makeTempRoot("openclaw-agent-exec-cwd-");
    const { runtime } = createRuntime();
    const runAgent = vi.fn(async () => successResult());

    await agentExecCommand("inspect", { cwd: root }, runtime, { runAgent });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: root, cwd: root }),
      expect.any(Object),
    );
  });

  it("emits the small stable JSON envelope", async () => {
    const { runtime, log } = createRuntime();

    const result = await agentExecCommand("inspect", { json: true }, runtime, {
      runAgent: vi.fn(async () => successResult("final answer")),
    });

    expect(result.exitCode).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      status: "ok",
      final: "final answer",
      payloads: [{ text: "final answer" }],
      usage: { input: 10, output: 2, total: 12 },
      model: "gpt-5.6-sol",
      provider: "openai",
      sessionId: "session-result",
    });
  });

  it("honors ordered fallbacks with an explicit primary model", async () => {
    const { runtime } = createRuntime();
    const runAgent = vi.fn(async () => successResult());

    await agentExecCommand(
      "inspect",
      {
        model: "openai/gpt-5.6-sol",
        fallback: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
      },
      runtime,
      { runAgent },
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.6-sol",
        modelFallbacksOverride: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
      }),
      expect.any(Object),
    );
  });

  it("keeps an explicit state directory and deletes only its temporary config", async () => {
    const stateDir = await makeTempRoot("openclaw-agent-exec-state-");
    const marker = path.join(stateDir, "keep.txt");
    await fs.writeFile(marker, "keep", "utf8");
    const { runtime } = createRuntime();
    let configPath = "";

    await agentExecCommand("inspect", { stateDir }, runtime, {
      runAgent: vi.fn(async () => {
        configPath = process.env.OPENCLAW_CONFIG_PATH ?? "";
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        return successResult();
      }),
    });

    await expect(fs.readFile(marker, "utf8")).resolves.toBe("keep");
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips external Codex CLI credentials in default auth-env-only mode", async () => {
    const codexHome = await makeTempRoot("openclaw-agent-exec-codex-home-");
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-access", refresh_token: "test-refresh" },
      }),
      "utf8",
    );
    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.CODEX_HOME = codexHome;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.DATABASE_URL = "postgres://test.invalid/database";
    const { runtime } = createRuntime();
    let profileIds: string[] = [];
    let runtimeProfileIds: string[] = [];
    let hostExecApiKey: string | undefined;
    let hostExecDatabaseUrl: string | undefined;
    try {
      const { withHostExecInheritedEnvOmitted } = await import("../infra/host-env-security.js");
      await withHostExecInheritedEnvOmitted(["DATABASE_URL"], () =>
        agentExecCommand("inspect", {}, runtime, {
          runAgent: vi.fn(async () => {
            profileIds = Object.keys(
              ensureAuthProfileStore(undefined, {
                allowKeychainPrompt: false,
                externalCliProviderIds: ["openai"],
              }).profiles,
            );
            runtimeProfileIds = Object.keys(
              loadAuthProfileStoreForRuntime(undefined, {
                allowKeychainPrompt: false,
                externalCliProviderIds: ["openai"],
              }).profiles,
            );
            const { sanitizeHostExecEnv } = await import("../infra/host-env-security.js");
            const hostExecEnv = sanitizeHostExecEnv({ baseEnv: process.env });
            hostExecApiKey = hostExecEnv.OPENAI_API_KEY;
            hostExecDatabaseUrl = hostExecEnv.DATABASE_URL;
            return successResult();
          }),
        }),
      );
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }

    expect(profileIds).toEqual([]);
    expect(runtimeProfileIds).toEqual([]);
    expect(hostExecApiKey).toBeUndefined();
    expect(hostExecDatabaseUrl).toBeUndefined();
  });

  it("blocks direct persisted credential reads in default auth-env-only mode", async () => {
    const normalStateDir = await makeTempRoot("openclaw-agent-exec-hidden-auth-");
    const normalAgentDir = path.join(normalStateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = normalStateDir;
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:stored": { type: "api_key", provider: "openai", key: "test-key" },
        },
      },
      normalAgentDir,
    );
    const { runtime } = createRuntime();
    let persistedCredential: unknown;
    let ownerAgentDir: string | undefined;
    try {
      await agentExecCommand("inspect", {}, runtime, {
        runAgent: vi.fn(async () => {
          persistedCredential = findPersistedAuthProfileCredential({
            agentDir: normalAgentDir,
            profileId: "openai:stored",
          });
          ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
            agentDir: normalAgentDir,
            profileId: "openai:stored",
          });
          return successResult();
        }),
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(persistedCredential).toBeUndefined();
    expect(ownerAgentDir).toBeUndefined();
  });

  it("uses the normal stored auth profile when auth-env-only is disabled", async () => {
    const normalStateDir = await makeTempRoot("openclaw-agent-exec-normal-state-");
    const normalAgentDir = path.join(normalStateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = normalStateDir;
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:stored": { type: "api_key", provider: "openai", key: "test-key" },
        },
      },
      normalAgentDir,
    );
    const { runtime } = createRuntime();
    let profileIds: string[] = [];
    try {
      await agentExecCommand("inspect", { authEnvOnly: false }, runtime, {
        runAgent: vi.fn(async () => {
          expect(process.env.OPENCLAW_STATE_DIR).not.toBe(normalStateDir);
          profileIds = Object.keys(
            ensureAuthProfileStore(undefined, {
              allowKeychainPrompt: false,
              syncExternalCli: false,
            }).profiles,
          );
          return successResult();
        }),
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(profileIds).toContain("openai:stored");
  });
});
