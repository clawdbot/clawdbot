import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunTerminalOutcomeError } from "../agents/agent-run-terminal-outcome.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForRuntime,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  agentExecCommand,
  buildExecRunConfig,
  classifyAgentExecResult,
  resolveAgentExecPrompt,
  resolveExecBaseConfig,
} from "./agent-exec.js";

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

  it("projects the embedded outer tool summary", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 10,
        toolSummary: {
          calls: 2,
          tools: ["read", "write"],
          failures: 1,
          totalToolTimeMs: 25,
        },
      },
    });
    expect(envelope.toolSummary).toEqual({
      calls: 2,
      tools: ["read", "write"],
      failures: 1,
      totalToolTimeMs: 25,
    });
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

  it("maps embedded terminal-outcome timeouts to exit code 2", async () => {
    const { runtime } = createRuntime();
    const timeout = new AgentRunTerminalOutcomeError(
      new Error("attempt aborted before prompt submission"),
      {
        reason: "hard_timeout",
        status: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
    );

    const result = await agentExecCommand("inspect", { json: true }, runtime, {
      runAgent: vi.fn(async () => {
        throw timeout;
      }),
    });

    expect(result).toMatchObject({
      exitCode: 2,
      envelope: {
        status: "timeout",
        error: {
          kind: "timeout",
          message: "attempt aborted before prompt submission",
        },
      },
    });
  });

  it("creates and removes ephemeral state around the embedded run", async () => {
    const { runtime } = createRuntime();
    let observedStateDir = "";
    let observedConfigPath: string | undefined;
    let observedConfig: unknown;
    const result = await agentExecCommand("inspect", {}, runtime, {
      runAgent: vi.fn(async () => {
        observedStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
        observedConfigPath = process.env.OPENCLAW_CONFIG_PATH;
        // The published snapshot is what the run reads; exec writes no config file.
        observedConfig = getRuntimeConfigSnapshot();
        await expect(fs.stat(observedStateDir)).resolves.toBeDefined();
        return successResult();
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(observedConfigPath).toBeUndefined();
    await expect(fs.readdir(observedStateDir).catch(() => [])).resolves.not.toContain(
      "openclaw.json",
    );
    expect(observedConfig).toMatchObject({
      agents: { defaults: { skipBootstrap: true, sandbox: { mode: "off" } } },
      tools: {
        profile: "coding",
        fs: { workspaceOnly: true },
        exec: { mode: "full" },
      },
    });
    await expect(fs.stat(observedStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers operator-installed plugins while run state stays ephemeral", async () => {
    const operatorStateDir = await makeTempRoot("openclaw-agent-exec-plugin-owner-");
    const pluginDir = path.join(operatorStateDir, "extensions", "exec-provider");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "exec-provider",
        configSchema: { type: "object", additionalProperties: false },
        providers: ["exec-provider"],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "exec-provider",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), "export default {}\n", "utf8");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = operatorStateDir;
    const { runtime } = createRuntime();
    let runtimeStateDir = "";
    let discoveredRoot = "";
    try {
      await agentExecCommand("inspect", {}, runtime, {
        runAgent: vi.fn(async () => {
          runtimeStateDir = process.env.OPENCLAW_STATE_DIR ?? "";
          const { resolvePluginMetadataSnapshot } =
            await import("../plugins/plugin-metadata-snapshot.js");
          const snapshot = resolvePluginMetadataSnapshot({
            allowCurrent: false,
            config: { plugins: { entries: { "exec-provider": { enabled: true } } } },
            env: process.env,
            preferPersisted: false,
          });
          discoveredRoot = snapshot.byPluginId.get("exec-provider")?.rootDir ?? "";
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

    expect(runtimeStateDir).not.toBe(operatorStateDir);
    await expect(fs.realpath(discoveredRoot)).resolves.toBe(await fs.realpath(pluginDir));
    await expect(fs.stat(runtimeStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps operator-installed plugins hidden under --isolated", async () => {
    const operatorStateDir = await makeTempRoot("openclaw-agent-exec-plugin-isolated-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = operatorStateDir;
    const { runtime } = createRuntime();
    let resolvedExtensionsDir = "";
    try {
      await agentExecCommand("inspect", { isolated: true }, runtime, {
        runAgent: vi.fn(async () => {
          const { resolveDefaultPluginExtensionsDir } = await import("../plugins/install-paths.js");
          resolvedExtensionsDir = resolveDefaultPluginExtensionsDir();
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

    expect(resolvedExtensionsDir).not.toBe(path.join(operatorStateDir, "extensions"));
    expect(path.basename(path.dirname(resolvedExtensionsDir))).toMatch(/^openclaw-agent-exec-/u);
  });

  it("keeps --state-dir scoped to run state instead of plugin installs", async () => {
    const operatorStateDir = await makeTempRoot("openclaw-agent-exec-plugin-operator-");
    const retainedRunStateDir = await makeTempRoot("openclaw-agent-exec-retained-state-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = operatorStateDir;
    const { runtime } = createRuntime();
    let resolvedExtensionsDir = "";
    try {
      await agentExecCommand("inspect", { stateDir: retainedRunStateDir }, runtime, {
        runAgent: vi.fn(async () => {
          expect(process.env.OPENCLAW_STATE_DIR).toBe(retainedRunStateDir);
          const { resolveDefaultPluginExtensionsDir } = await import("../plugins/install-paths.js");
          resolvedExtensionsDir = resolveDefaultPluginExtensionsDir();
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

    expect(resolvedExtensionsDir).toBe(path.join(operatorStateDir, "extensions"));
    await expect(fs.stat(retainedRunStateDir)).resolves.toBeDefined();
  });

  it("applies explicit Code Mode and lean local-model controls to the isolated config", async () => {
    const { runtime } = createRuntime();
    let observedConfig: unknown;

    const result = await agentExecCommand(
      "inspect",
      { codeMode: "code", localModelLean: true },
      runtime,
      {
        runAgent: vi.fn(async () => {
          observedConfig = getRuntimeConfigSnapshot();
          return successResult();
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(observedConfig).toMatchObject({
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { codeMode: true },
    });
  });

  it("rejects invalid programmatic Code Mode values", async () => {
    const { runtime } = createRuntime();

    const result = await agentExecCommand("inspect", { codeMode: "invalid" as never }, runtime, {
      runAgent: vi.fn(async () => successResult()),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: {
        status: "error",
        error: { kind: "exception", message: "--code-mode must be one of direct, auto, code." },
      },
    });
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

  it("undoes environment mutations made by loading the config", async () => {
    const seedDir = await makeTempRoot("openclaw-agent-exec-envseed-");
    const seedPath = path.join(seedDir, "openclaw.json");
    await fs.writeFile(
      seedPath,
      JSON.stringify({ env: { vars: { OPENCLAW_EXEC_ENV_PROBE: "from-config" } } }),
      "utf8",
    );
    const { runtime } = createRuntime();
    let observedDuringRun: string | undefined;

    await agentExecCommand("inspect", { config: seedPath }, runtime, {
      runAgent: vi.fn(async () => {
        observedDuringRun = process.env.OPENCLAW_EXEC_ENV_PROBE;
        return successResult();
      }),
    });

    expect(observedDuringRun).toBe("from-config");
    // Config-applied values must not outlive the command, or a later isolated
    // run in the same process would inherit them.
    expect(process.env.OPENCLAW_EXEC_ENV_PROBE).toBeUndefined();
  });

  it("leaves no runtime config snapshot behind when the caller had none", async () => {
    clearRuntimeConfigSnapshot();
    const { runtime } = createRuntime();

    await agentExecCommand("inspect", {}, runtime, {
      runAgent: vi.fn(async () => successResult()),
    });

    // Resolving the ambient config pins a snapshot of its own, so "previous" has
    // to be read before that happens or cleanup reinstalls exec's own load.
    expect(getRuntimeConfigSnapshot() ?? undefined).toBeUndefined();
  });

  it("restores a caller's runtime config snapshot after the run", async () => {
    const callerSnapshot = {
      models: { providers: { caller: { baseUrl: "https://caller.invalid", models: [] } } },
    };
    setRuntimeConfigSnapshot(callerSnapshot);
    const { runtime } = createRuntime();
    let observedDuringRun: string | undefined;

    try {
      await agentExecCommand("inspect", {}, runtime, {
        runAgent: vi.fn(async () => {
          observedDuringRun = getRuntimeConfigSnapshot()?.tools?.profile;
          return successResult();
        }),
      });

      // The run sees exec's composed config...
      expect(observedDuringRun).toBe("coding");
      // ...and the caller gets its own back afterwards.
      expect(getRuntimeConfigSnapshot()?.models?.providers?.caller?.baseUrl).toBe(
        "https://caller.invalid",
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("publishes no config env values when the config load fails", async () => {
    const seedDir = await makeTempRoot("openclaw-agent-exec-badenv-");
    const seedPath = path.join(seedDir, "openclaw.json");
    // The loader owns this: it applies `env.vars` only after validation passes,
    // and restores them from its own catch. Pinned here because the observable
    // contract matters regardless of which layer enforces it.
    await fs.writeFile(
      seedPath,
      JSON.stringify({
        env: { vars: { OPENCLAW_EXEC_FAILED_PROBE: "from-rejected-config" } },
        agents: { defaults: { sandbox: { mode: "not-a-real-mode" } } },
      }),
      "utf8",
    );
    const { runtime } = createRuntime();

    const result = await agentExecCommand("inspect", { config: seedPath }, runtime, {
      runAgent: vi.fn(async () => successResult()),
    });

    expect(result.exitCode).not.toBe(0);
    expect(process.env.OPENCLAW_EXEC_FAILED_PROBE).toBeUndefined();
  });

  it("leaves an explicit state directory untouched", async () => {
    const stateDir = await makeTempRoot("openclaw-agent-exec-state-");
    const marker = path.join(stateDir, "keep.txt");
    await fs.writeFile(marker, "keep", "utf8");
    const { runtime } = createRuntime();

    await agentExecCommand("inspect", { stateDir }, runtime, {
      runAgent: vi.fn(async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        return successResult();
      }),
    });

    await expect(fs.readFile(marker, "utf8")).resolves.toBe("keep");
    // The run config inherits the ambient config, so a retained state dir must
    // never receive a serialized copy of it.
    await expect(fs.readdir(stateDir)).resolves.toEqual(["keep.txt"]);
  });

  it("skips external Codex CLI credentials under --auth-env-only", async () => {
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
        agentExecCommand("inspect", { authEnvOnly: true }, runtime, {
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

  it("reads stored credentials from the configured agent directory", async () => {
    const stateDir = await makeTempRoot("openclaw-agent-exec-cfg-auth-");
    const customAgentDir = path.join(stateDir, "custom-home");
    await fs.mkdir(customAgentDir, { recursive: true });
    const seedPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      seedPath,
      JSON.stringify({
        agents: { entries: { main: { agentDir: customAgentDir } } },
      }),
      "utf8",
    );
    const { saveAuthProfileStore } = await import("../agents/auth-profiles.js");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:stored": { type: "api_key", provider: "openai", key: "test-key" } },
      },
      customAgentDir,
    );
    const { runtime } = createRuntime();
    let scopedProfileIds: string[] = [];

    await agentExecCommand("inspect", { config: seedPath }, runtime, {
      runAgent: vi.fn(async () => {
        scopedProfileIds = Object.keys(loadAuthProfileStoreForRuntime()?.profiles ?? {});
        return successResult();
      }),
    });

    // The run config strips agentDir to keep run state ephemeral, but credential
    // ownership must still follow the operator's configured directory.
    expect(scopedProfileIds).toContain("openai:stored");
  });

  it("blocks direct persisted credential reads under --auth-env-only", async () => {
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
      await agentExecCommand("inspect", { authEnvOnly: true }, runtime, {
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

describe("agent exec run config layering", () => {
  it("keeps the run scoped to the invocation folder over any config", () => {
    const config = buildExecRunConfig({
      base: { agents: { defaults: { workspace: "/elsewhere", skipBootstrap: false } } },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.workspace).toBe("/run/here");
    expect(config.agents?.defaults?.skipBootstrap).toBe(true);
  });

  it("never downgrades a configured sandbox or shell env to the exec defaults", () => {
    const config = buildExecRunConfig({
      base: {
        env: { shellEnv: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { profile: "full" },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(config.env?.shellEnv?.enabled).toBe(true);
    expect(config.tools?.profile).toBe("full");
  });

  it("applies coding one-shot defaults when the config leaves them unset", () => {
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(config.env?.shellEnv?.enabled).toBe(false);
    expect(config.tools?.profile).toBe("coding");
    expect(config.tools?.fs?.workspaceOnly).toBe(true);
  });

  it("leaves exec host routing to the configured sandbox", () => {
    const sandboxed = buildExecRunConfig({
      base: { agents: { defaults: { sandbox: { mode: "all" } } } },
      cwd: "/run/here",
    });

    expect(sandboxed.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(sandboxed.tools?.exec?.host).toBeUndefined();
    expect(buildExecRunConfig({ base: {}, cwd: "/run/here" }).tools?.exec?.host).toBeUndefined();
  });

  it("carries config-owned provider and harness surfaces into the run", () => {
    const config = buildExecRunConfig({
      base: {
        models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },
        tools: { codeMode: { enabled: true } },
      },
      cwd: "/run/here",
    });

    expect(config.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
    expect(config.tools?.codeMode).toMatchObject({ enabled: true });
  });

  it("pins per-agent workspaces to the invocation folder", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { workspace: "/elsewhere" } } } },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.workspace).toBe("/run/here");
  });

  it("drops inherited agent directories so run state stays in the state dir", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: { ops: { agentDir: "/persistent/agents/ops", model: "openai/gpt-5.6-sol" } },
        },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.agentDir).toBeUndefined();
    // Only the directory is dropped; the rest of the entry is still inherited.
    expect(config.agents?.entries?.ops?.model).toBe("openai/gpt-5.6-sol");
  });

  it("drops an inherited harness cwd so --cwd wins", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: {
            ops: { runtime: { type: "acp", acp: { agent: "codex", cwd: "/other/repo" } } },
          },
        },
      },
      cwd: "/run/here",
    });

    const runtime = config.agents?.entries?.ops?.runtime;
    expect(runtime?.type === "acp" ? runtime.acp?.cwd : "unset").toBeUndefined();
    // The rest of the harness selection survives.
    expect(runtime?.type === "acp" ? runtime.acp?.agent : undefined).toBe("codex");
  });

  it("lets explicit flags outrank the resolved config", () => {
    const config = buildExecRunConfig({
      base: { tools: { codeMode: { enabled: true } } },
      cwd: "/run/here",
      opts: { codeMode: "direct", localModelLean: true },
    });

    expect(config.tools?.codeMode).toBe(false);
    expect(config.agents?.defaults?.experimental?.localModelLean).toBe(true);
  });
});

describe("agent exec base config resolution", () => {
  const seedConfig = {
    models: {
      providers: {
        custom: {
          apiKey: "sk-config",
          baseUrl: "https://example.invalid",
          headers: { Authorization: "Bearer header-secret" },
          request: { auth: { mode: "authorization-bearer", token: "request-secret" } },
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;

  async function writeSeed(body: string): Promise<string> {
    const dir = await makeTempRoot("openclaw-agent-exec-seed-");
    const seedPath = path.join(dir, "openclaw.json");
    await fs.writeFile(seedPath, body, "utf8");
    return seedPath;
  }

  it("rejects a missing or invalid pinned config instead of falling back", async () => {
    const missing = path.join(await makeTempRoot("openclaw-agent-exec-seed-"), "absent.json");
    await expect(resolveExecBaseConfig({ config: missing })).rejects.toThrow(
      "--config file not found",
    );

    const broken = await writeSeed("{ this is not a config");
    await expect(resolveExecBaseConfig({ config: broken })).rejects.toThrow();
  });

  it("reads the pinned file even when a runtime snapshot is already published", async () => {
    const seedPath = await writeSeed(
      JSON.stringify({
        models: { providers: { custom: { baseUrl: "https://from-file.invalid", models: [] } } },
      }),
    );
    setRuntimeConfigSnapshot({
      models: { providers: { custom: { baseUrl: "https://from-snapshot.invalid", models: [] } } },
    });

    try {
      const resolved = await resolveExecBaseConfig({ config: seedPath });
      expect(resolved.models?.providers?.custom?.baseUrl).toBe("https://from-file.invalid");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("reads --config through the JSON5-aware loader", async () => {
    const seedPath = await writeSeed(
      `{\n  // pinned run config\n  models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },\n}\n`,
    );

    const resolved = await resolveExecBaseConfig({ config: seedPath });

    expect(resolved.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
  });

  it("rejects --config paired with a mode that reads no config", async () => {
    const seedPath = await writeSeed(JSON.stringify(seedConfig));

    await expect(resolveExecBaseConfig({ config: seedPath, isolated: true })).rejects.toThrow(
      "--config cannot be combined with --isolated",
    );
    await expect(resolveExecBaseConfig({ config: seedPath, authEnvOnly: true })).rejects.toThrow(
      "--config cannot be combined with --auth-env-only",
    );
  });

  it("reads no config at all under --auth-env-only", async () => {
    const seedPath = await writeSeed(JSON.stringify(seedConfig));

    // A config can supply provider credentials through several surfaces, so
    // env-only means no config at all.
    await expect(resolveExecBaseConfig({ authEnvOnly: true })).resolves.toEqual({});
    // Proves the assertion above is not vacuous.
    const inherited = await resolveExecBaseConfig({ config: seedPath });
    expect(inherited.models?.providers?.custom?.apiKey).toBe("sk-config");
  });

  it("ignores the ambient config under --isolated", async () => {
    await expect(resolveExecBaseConfig({ isolated: true })).resolves.toEqual({});
  });
});
