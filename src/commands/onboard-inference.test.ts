// Inference backend detection tests cover the documented ladder and login-awareness.
import { describe, expect, it } from "vitest";
import type { LocalCommandProbe } from "../system-agent/probes.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
} from "./onboard-inference.js";
import { detectNativeCodexAppServer } from "./onboard-inference.test-support.js";

function probeDeps(found: Record<string, boolean>) {
  return async (command: string): Promise<LocalCommandProbe> => ({
    command,
    found: found[command] ?? false,
  });
}

describe("detectInferenceBackends", () => {
  it("uses route-specific GPT-5.6 defaults for direct API and Codex", () => {
    expect(OPENAI_API_DEFAULT_MODEL_REF).toBe("openai/gpt-5.6");
    expect(CODEX_APP_SERVER_DEFAULT_MODEL_REF).toBe("openai/gpt-5.6-sol");
  });

  it("returns nothing when no backend exists", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        readClaudeCliCredentials: () => null,
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toEqual([]);
  });

  it("orders the ladder: existing model, env keys, then CLI logins", async () => {
    const candidates = await detectInferenceBackends({
      config: { agents: { defaults: { model: "zai/glm-5.2" } } },
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({ claude: true, codex: true }),
        readClaudeCliCredentials: () => ({ type: "oauth" }),
        readCodexCliCredentials: () => ({ type: "oauth" }),
      },
    });
    expect(candidates.slice(0, 3).map((candidate) => candidate.kind)).toEqual([
      "existing-model",
      "openai-api-key",
      "anthropic-api-key",
    ]);
    expect(
      candidates
        .slice(3)
        .map((candidate) => candidate.kind)
        .toSorted(),
    ).toEqual(["claude-cli", "codex-cli"]);
    expect(candidates[0]?.modelRef).toBe("zai/glm-5.2");
    expect(candidates[1]?.modelRef).toBe(OPENAI_API_DEFAULT_MODEL_REF);
    expect(candidates[2]?.modelRef).toBe(ANTHROPIC_API_DEFAULT_MODEL_REF);
    expect(
      candidates
        .slice(3)
        .map((candidate) => candidate.modelRef)
        .toSorted(),
    ).toEqual([CLAUDE_CLI_DEFAULT_MODEL_REF, CODEX_APP_SERVER_DEFAULT_MODEL_REF].toSorted());
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
        readClaudeCliCredentials: () => null,
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
        },
      },
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probeDeps({}),
        readClaudeCliCredentials: () => null,
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
        readClaudeCliCredentials: () => null,
        readCodexCliCredentials: () => ({ type: "oauth" }),
      },
    });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["codex-cli", "claude-cli"]);
    expect(candidates[0]?.credentials).toBe(true);
    expect(candidates[1]?.credentials).toBe(false);
    expect(candidates[1]?.detail).toBe("installed, not logged in");
  });

  it("recognizes Codex login status across native credential stores", async () => {
    const probe = async (command: string, args: string[] = ["--version"]) => ({
      command,
      found: command === "codex",
      ...(args[0] === "login" ? {} : { version: "codex 1.0" }),
    });
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "linux",
      deps: {
        probeLocalCommand: probe,
      },
    });

    expect(candidates).toMatchObject([
      { kind: "codex-cli", credentials: true, detail: "logged in" },
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
          readClaudeCliCredentials: () => ({ type: "oauth" }),
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

  it("treats missing file credentials as unknown on macOS (keychain may hold the login)", async () => {
    const candidates = await detectInferenceBackends({
      env: {},
      platform: "darwin",
      deps: {
        probeLocalCommand: probeDeps({ claude: true }),
        readClaudeCliCredentials: () => null,
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("claude-cli");
    expect(candidates[0]?.credentials).toBeUndefined();
    expect(candidates[0]?.detail).toBe("installed");
  });

  it("detects a native Codex App Server independently of inference ranking", async () => {
    const command = "/Applications/ChatGPT.app/Contents/Resources/codex";

    await expect(
      detectNativeCodexAppServer({
        env: { HOME: "/Users/tester" },
        platform: "darwin",
        probeLocalCommand: probeDeps({ [command]: true }),
      }),
    ).resolves.toEqual({ command, found: true });
  });

  it("checks login status with the Codex executable discovered in a macOS app", async () => {
    const command = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const probed: Array<{ command: string; args: string[] }> = [];
    const candidates = await detectInferenceBackends({
      env: { HOME: "/Users/tester" },
      platform: "darwin",
      deps: {
        probeLocalCommand: async (probedCommand, args = ["--version"]) => {
          probed.push({ command: probedCommand, args });
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
    expect(probed).toContainEqual({ command, args: ["login", "status"] });
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
        readClaudeCliCredentials: () => null,
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
        readClaudeCliCredentials: () => null,
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
        readClaudeCliCredentials: () => null,
        readCodexCliCredentials: () => null,
      },
    });
    expect(candidates).toEqual([]);
  });
});
