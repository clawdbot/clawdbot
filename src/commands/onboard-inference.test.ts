// Inference backend detection tests cover the documented ladder and login-awareness.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { LocalCommandProbe } from "../system-agent/probes.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  detectInferenceBackends,
} from "./onboard-inference.js";

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  policyHash: "onboard-inference-test-empty-plugin-policy",
  configFingerprint: "onboard-inference-test-empty-plugin-metadata",
  index: {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "onboard-inference-test-empty-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

afterAll(() => {
  vi.doUnmock("../plugins/current-plugin-metadata-snapshot.js");
  vi.resetModules();
});

function probeDeps(found: Record<string, boolean>) {
  return async (command: string): Promise<LocalCommandProbe> => ({
    command,
    found: found[command] ?? false,
  });
}

describe("detectInferenceBackends", () => {
  it("returns nothing when no backend exists", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toEqual([]);
  });

  it("does not offer external CLIs whose version probes time out", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: async (command) => ({
          command,
          found: true,
          timedOut: true,
          error: "timed out after 1500ms",
        }),
        detectClaudeLoginState: async () => ({
          credentials: true,
          authKind: "claude-subscription",
        }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
        readGeminiCliCredentials: () => ({ type: "oauth" }),
      },
    });

    expect(candidates).toEqual([]);
  });

  it("orders the ladder: existing model, logged-in subscriptions, env keys, then fallback CLIs", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: { model: "zai/glm-5.2" },
          entries: { main: { default: true } },
        },
      },
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true, codex: true, gemini: true }),
        detectClaudeLoginState: async () => ({
          credentials: true,
          authKind: "claude-subscription",
        }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
        readGeminiCliCredentials: () => ({ type: "oauth" }),
        randomInt: () => 0,
      },
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "existing-model",
      "claude-cli",
      "codex-cli",
      "openai-api-key",
      "anthropic-api-key",
      "gemini-cli",
    ]);
    expect(candidates[0]?.modelRef).toBe("zai/glm-5.2");
    expect(candidates[0]?.detail).toBe("zai/glm-5.2 — already configured");
    expect(candidates[1]?.modelRef).toBe(CLAUDE_CLI_DEFAULT_MODEL_REF);
    expect(candidates[2]?.modelRef).toBe("openai/gpt-5.6-sol");
    expect(candidates[3]?.modelRef).toBe("openai/gpt-5.6-sol");
    expect(candidates[4]?.modelRef).toBe(ANTHROPIC_API_DEFAULT_MODEL_REF);
  });

  it("ranks a logged-in Codex subscription before an OpenAI environment key", async () => {
    const candidates = await detectInferenceBackends({
      env: { OPENAI_API_KEY: "sk-x" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ codex: true }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["codex-cli", "openai-api-key"]);
  });

  it("keeps status-only Codex login after env keys without verifiable OAuth tokens", async () => {
    const candidates = await detectInferenceBackends({
      env: { OPENAI_API_KEY: "sk-x" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ codex: true }),
        readCodexCliCredentials: () => null,
        detectCodexLoginState: async () => true,
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["openai-api-key", "codex-cli"]);
    expect(candidates[1]).toMatchObject({ credentials: true, detail: "logged in" });
  });

  it("keeps API-key-helper-backed Claude after environment keys", async () => {
    const candidates = await detectInferenceBackends({
      env: { ANTHROPIC_API_KEY: "sk-y" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        detectClaudeLoginState: async () => ({ credentials: true, authKind: "api-key" }),
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "anthropic-api-key",
      "claude-cli",
    ]);
    expect(candidates[1]).toMatchObject({
      credentials: true,
      detail: "logged in · API key (usage-billed)",
    });
  });

  it("labels a Claude CLI environment key as usage-billed", async () => {
    const candidates = await detectInferenceBackends({
      env: { ANTHROPIC_API_KEY: "sk-y" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        detectClaudeLoginState: async () => ({ credentials: true, authKind: "api-key" }),
      },
    });

    expect(candidates.find((candidate) => candidate.kind === "claude-cli")?.detail).toBe(
      "logged in · API key (usage-billed)",
    );
  });

  it("labels a Claude CLI subscription reported by its status command", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        detectClaudeLoginState: async () => ({
          credentials: true,
          authKind: "claude-subscription",
        }),
      },
    });

    expect(candidates).toMatchObject([
      {
        kind: "claude-cli",
        credentials: true,
        detail: "logged in · Claude subscription",
      },
    ]);
  });

  it("keeps an Anthropic environment key ahead of unknown Claude status", async () => {
    const candidates = await detectInferenceBackends({
      env: { ANTHROPIC_API_KEY: "sk-y" },
      platform: "darwin",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        detectClaudeLoginState: async () => ({ credentials: undefined }),
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "anthropic-api-key",
      "claude-cli",
    ]);
    expect(candidates[1]?.credentials).toBeUndefined();
  });

  it("keeps a logged-in Gemini CLI after environment keys", async () => {
    const candidates = await detectInferenceBackends({
      env: { OPENAI_API_KEY: "sk-x" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ gemini: true }),
        readGeminiCliCredentials: () => ({ type: "oauth" }),
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["openai-api-key", "gemini-cli"]);
  });

  it("keeps the existing model first and definitively logged-out CLIs last", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: { model: "zai/glm-5.2" },
          entries: { main: { default: true } },
        },
      },
      env: { OPENAI_API_KEY: "sk-x" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true, codex: true, gemini: true }),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
        readGeminiCliCredentials: () => null,
      },
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "existing-model",
      "codex-cli",
      "openai-api-key",
      "gemini-cli",
      "claude-cli",
    ]);
  });

  it("prefers the configured default agent model over the global default", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          list: [
            { id: "fallback", model: "google/gemini-3.1-pro-preview" },
            { id: "ops", default: true, model: "anthropic/claude-opus-4-8" },
          ],
        },
      },
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });

    expect(candidates).toMatchObject([
      { kind: "existing-model", modelRef: "anthropic/claude-opus-4-8" },
    ]);
  });

  it("captures the canonical target for an authored model alias", async () => {
    const candidates = await detectInferenceBackends({
      config: {
        agents: {
          defaults: {
            model: { primary: "opus" },
            models: { "anthropic/claude-opus-4-8": { alias: "opus" } },
          },
          entries: { main: { default: true } },
        },
      },
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });

    expect(candidates).toMatchObject([
      { kind: "existing-model", modelRef: "anthropic/claude-opus-4-8" },
    ]);
  });

  it("sinks a definitively logged-out CLI below a logged-in one", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true, codex: true }),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
      },
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["codex-cli", "claude-cli"]);
    expect(candidates[0]?.credentials).toBe(true);
    expect(candidates[1]?.credentials).toBe(false);
    expect(candidates[1]?.detail).toBe(
      "installed, not logged in — run `claude auth login`, then check again",
    );
  });

  it("keeps Gemini private-store auth distinct from definitive CLI logouts", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true, codex: true, gemini: true }),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
        readGeminiCliCredentials: () => null,
      },
    });

    expect(candidates).toMatchObject([
      {
        kind: "gemini-cli",
        detail: "installed; login status unavailable",
      },
      {
        kind: "claude-cli",
        detail: "installed, not logged in — run `claude auth login`, then check again",
      },
      {
        kind: "codex-cli",
        detail: "installed, not logged in — run `codex login`, then check again",
      },
    ]);
    expect(
      candidates.find((candidate) => candidate.kind === "gemini-cli")?.credentials,
    ).toBeUndefined();
  });

  it.each([
    ["ChatGPT", "Logged in using ChatGPT", "logged in · ChatGPT subscription"],
    [
      "API key",
      "Logged in using an API key - sk-proj-1***23456",
      "logged in · API key (usage-billed)",
    ],
    ["unrecognized auth", "Logged in using access token", "logged in"],
  ])("classifies Codex %s login status", async (_auth, loginOutput, expectedDetail) => {
    const probe = async (command: string, args: string[] = ["--version"]) => ({
      command,
      found: command === "codex",
      version: args[0] === "login" ? loginOutput : "codex 1.0",
    });
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probe,
      },
    });

    expect(candidates).toMatchObject([
      { kind: "codex-cli", credentials: true, detail: expectedDetail },
    ]);
  });

  it("keeps Codex store logout indeterminate for custom provider credentials", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "darwin",
      deps: {
        probeLocalCommand: async (command: string, args: string[] = ["--version"]) => ({
          command,
          found: command === "codex",
          ...(args[0] === "login" ? { version: "Not logged in", error: "exited 1" } : {}),
        }),
      },
    });

    expect(candidates).toMatchObject([{ kind: "codex-cli", detail: "installed" }]);
    expect(candidates[0]?.credentials).toBeUndefined();
  });

  it("keeps an indeterminate Codex status error distinct from logout", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: async (command: string, args: string[] = ["--version"]) => ({
          command,
          found: command === "codex",
          ...(args[0] === "login"
            ? { version: "Error checking login status: keyring unavailable", error: "exited 1" }
            : {}),
        }),
      },
    });

    expect(candidates).toMatchObject([{ kind: "codex-cli", detail: "installed" }]);
    expect(candidates[0]?.credentials).toBeUndefined();
  });

  it("treats working Claude and Codex logins as randomized peers", async () => {
    const detectWithPick = async (pick: number) =>
      await detectInferenceBackends({
        env: {},
        platform: "linux",
        deps: {
          probeLocalCommand: probeDeps({ claude: true, codex: true }),
          detectClaudeLoginState: async () => ({
            credentials: true,
            authKind: "claude-subscription",
          }),
          readCodexCliCredentials: () => ({ type: "oauth" }),
          randomInt: () => pick,
        },
      });

    expect((await detectWithPick(0)).map((candidate) => candidate.kind)).toEqual([
      "claude-cli",
      "codex-cli",
    ]);
    expect((await detectWithPick(1)).map((candidate) => candidate.kind)).toEqual([
      "codex-cli",
      "claude-cli",
    ]);
  });

  it("keeps an unverified Claude status unknown", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "darwin",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        detectClaudeLoginState: async () => ({ credentials: undefined }),
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("claude-cli");
    expect(candidates[0]?.credentials).toBeUndefined();
    expect(candidates[0]?.detail).toBe("installed");
  });

  it("checks login status with the Codex executable discovered in a macOS app", async () => {
    const command = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const probed: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const candidates = await detectInferenceBackends({
      env: { HOME: "/Users/tester" },
      platform: "darwin",
      deps: {
        probeLocalCommand: async (probedCommand, args = ["--version"], opts = {}) => {
          probed.push({ command: probedCommand, args, timeoutMs: opts.timeoutMs });
          return {
            command: probedCommand,
            found: probedCommand === command,
            ...(args[0] === "login" ? { version: "Not logged in", error: "exited 1" } : {}),
          };
        },
      },
    });

    expect(candidates).toMatchObject([{ kind: "codex-cli", detail: "installed" }]);
    expect(candidates[0]?.credentials).toBeUndefined();
    expect(probed).toContainEqual({ command, args: ["--version"], timeoutMs: 3_000 });
    expect(probed).toContainEqual({ command, args: ["login", "status"], timeoutMs: 3_000 });
  });

  it("allows a cold ChatGPT app probe more time than generic CLI discovery", async () => {
    const command = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const candidates = await detectInferenceBackends({
      env: { HOME: "/Users/tester" },
      platform: "darwin",
      deps: {
        probeLocalCommand: async (probedCommand, args = ["--version"], opts = {}) => {
          if (probedCommand !== command) {
            return { command: probedCommand, found: false };
          }
          if (args[0] === "login") {
            return { command: probedCommand, found: true, version: "Logged in using ChatGPT" };
          }
          return opts.timeoutMs === 3_000
            ? { command: probedCommand, found: true, version: "codex-cli 0.149.0" }
            : {
                command: probedCommand,
                found: true,
                timedOut: true,
                error: "timed out after 1500ms",
              };
        },
      },
    });

    expect(candidates).toMatchObject([
      {
        kind: "codex-cli",
        credentials: true,
        detail: "logged in · ChatGPT subscription",
      },
    ]);
  });

  it.each([
    ["system ChatGPT", "/Applications/ChatGPT.app/Contents/Resources/codex", "/Users/tester"],
    [
      "user ChatGPT",
      "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/tester",
    ],
    ["system", "/Applications/Codex.app/Contents/Resources/codex", "/Users/tester"],
    ["user", "/Users/tester/Applications/Codex.app/Contents/Resources/codex", "/Users/tester"],
    ["system beta", "/Applications/Codex Beta.app/Contents/Resources/codex", "/Users/tester"],
    [
      "user beta",
      "/Users/tester/Applications/Codex Beta.app/Contents/Resources/codex",
      "/Users/tester",
    ],
  ])("finds the Codex CLI bundled in the %s macOS app directory", async (_scope, appCli, home) => {
    const candidates = await detectInferenceBackends({
      env: { HOME: home },
      platform: "darwin",
      deps: {
        probeLocalCommand: probeDeps({ [appCli]: true }),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "codex-cli",
      detail: "installed",
    });
  });

  it("prefers a user ChatGPT app before a system legacy Codex app", async () => {
    const probed: string[] = [];
    const chatGPTCli = "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex";
    const legacyCodexCli = "/Applications/Codex.app/Contents/Resources/codex";
    const candidates = await detectInferenceBackends({
      env: { HOME: "/Users/tester" },
      platform: "darwin",
      deps: {
        probeLocalCommand: async (command) => {
          probed.push(command);
          return {
            command,
            found: command === chatGPTCli || command === legacyCodexCli,
          };
        },
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });

    expect(candidates).toMatchObject([{ kind: "codex-cli", detail: "installed" }]);
    expect(probed).toContain(chatGPTCli);
    expect(probed).not.toContain(legacyCodexCli);
  });

  it("ignores blank env keys", async () => {
    const candidates = await detectInferenceBackends({
      env: { OPENAI_API_KEY: "   " },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        detectClaudeLoginState: async () => ({ credentials: false }),
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toEqual([]);
  });
});
