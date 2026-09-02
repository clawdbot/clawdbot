// System-agent timeout tests cover manifest-owned local-route classification.
import { describe, expect, it } from "vitest";
import {
  SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
  SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
} from "./assistant-prompts.js";
import "./assistant-timeout.js";

const { resolveSystemAgentAssistantTimeoutFromManifests } = (
  globalThis as Record<PropertyKey, unknown>
)[Symbol.for("openclaw.systemAgentTimeoutTestApi")] as {
  resolveSystemAgentAssistantTimeoutFromManifests: (params: {
    route: { modelLabel: string; provider: string };
    plugins: ReadonlyArray<{
      modelPricing?: { providers?: Record<string, { external?: boolean }> };
    }>;
  }) => number;
};

describe("system-agent assistant timeout", () => {
  it.each([
    {
      name: "external provider",
      provider: "openai",
      modelLabel: "openai/gpt-5.5",
      external: true,
      expected: SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
    },
    {
      name: "local provider",
      provider: "ollama",
      modelLabel: "ollama/qwen3.5:4b",
      external: false,
      expected: SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
    },
    {
      name: "hosted sibling provider",
      provider: "ollama-cloud",
      modelLabel: "ollama-cloud/glm-5.2:cloud",
      external: true,
      expected: SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
    },
  ])("uses the $name budget", ({ provider, modelLabel, external, expected }) => {
    expect(
      resolveSystemAgentAssistantTimeoutFromManifests({
        route: { provider, modelLabel },
        plugins: [{ modelPricing: { providers: { [provider]: { external } } } }],
      }),
    ).toBe(expected);
  });
});
