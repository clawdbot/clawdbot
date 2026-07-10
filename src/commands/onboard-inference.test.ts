// Inference backend detection tests cover the documented ladder and login-awareness.
import { describe, expect, it } from "vitest";
import type { LocalCommandProbe } from "../crestodian/probes.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
} from "./onboard-inference.js";

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
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "existing-model",
      "openai-api-key",
      "anthropic-api-key",
      "claude-cli",
      "codex-cli",
    ]);
    expect(candidates[0]?.modelRef).toBe("zai/glm-5.2");
    expect(candidates[1]?.modelRef).toBe(OPENAI_API_DEFAULT_MODEL_REF);
    expect(candidates[2]?.modelRef).toBe(ANTHROPIC_API_DEFAULT_MODEL_REF);
    expect(candidates[3]?.modelRef).toBe(CLAUDE_CLI_DEFAULT_MODEL_REF);
    expect(candidates[4]?.modelRef).toBe(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
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
