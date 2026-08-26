// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT,
  SYSTEM_AGENT_SYSTEM_PROMPT,
} from "../system-agent/assistant-prompts.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import { TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT } from "./transcript-credential-safety.js";

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function buildPrompt(config: OpenClawConfig, agentId = "main", sessionKey?: string): string {
  return buildConfiguredAgentSystemPrompt({
    config,
    agentId,
    workspaceDir: "/tmp/openclaw",
    toolNames: ["sessions_spawn", "subagents"],
    runtimeInfo: { sessionKey },
  });
}

describe("buildConfiguredAgentSystemPrompt", () => {
  it.each([
    {
      name: "prefers delegation in the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: true,
    },
    {
      name: "suggests delegation outside the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:slack:channel:C01234567",
      expected: false,
    },
    {
      name: "recognizes a custom canonical main key",
      config: { session: { mainKey: "inbox" } } satisfies OpenClawConfig,
      sessionKey: "agent:main:inbox",
      expected: true,
    },
    {
      name: "recognizes the global-scope canonical main key",
      config: { session: { scope: "global" } } satisfies OpenClawConfig,
      sessionKey: "global",
      expected: true,
    },
    {
      name: "suggests delegation without a render session key",
      config: {} satisfies OpenClawConfig,
      sessionKey: undefined,
      expected: false,
    },
    {
      name: "honors explicit prefer outside the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "prefer" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:dashboard:project",
      expected: true,
    },
    {
      name: "honors explicit suggest in the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "suggest" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: false,
    },
  ])("$name", ({ config, sessionKey, expected }) => {
    const prompt = buildPrompt(config, "main", sessionKey);
    expect(prompt.includes("## Delegation")).toBe(expected);
    expect(prompt.includes("- Subagents: `sessions_spawn`")).toBe(!expected);
  });

  it("inherits default sub-agent delegation mode", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config)).toContain("## Delegation");
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config, "coordinator")).toContain("## Delegation");
  });

  it("applies config-backed prompt parameters through the canonical facade", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });

    expect(prompt).toContain("## Delegation");
  });

  it("keeps the credential contract unless the operator opts out", () => {
    expect(buildPrompt({})).toContain(TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT);
    expect(buildPrompt({ security: {} })).toContain(TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT);
    expect(buildPrompt({ security: { allowCredentialsInTranscript: false } })).toContain(
      TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT,
    );
  });

  it("drops only the handling rules when the operator opts out", () => {
    const prompt = buildPrompt({ security: { allowCredentialsInTranscript: true } });

    expect(prompt).not.toContain(TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT);
    expect(prompt).not.toContain("Never echo or repeat credentials");
    expect(prompt).not.toContain("Never place, put, or include credentials");
    expect(prompt).toContain("Safety/oversight > completion");
  });

  it("never lets the opt-out remove the no-solicitation rule", () => {
    // Soliciting a credential creates exposure that would not otherwise exist,
    // and it reaches non-owner participants, so no config value removes it.
    for (const config of [
      {},
      { security: {} },
      { security: { allowCredentialsInTranscript: false } },
      { security: { allowCredentialsInTranscript: true } },
    ]) {
      expect(buildPrompt(config)).toContain(
        "never ask or request users to report, share, or provide",
      );
    }
  });

  it("keeps the credential contract in system-agent prompts regardless of the opt-out", () => {
    // The system agent carries the contract in its own module-scope prompts, so
    // the operator opt-out cannot reach it no matter how config is resolved.
    for (const prompt of [SYSTEM_AGENT_SYSTEM_PROMPT, SYSTEM_AGENT_ASSISTANT_SYSTEM_PROMPT]) {
      expect(prompt).toContain(TRANSCRIPT_CREDENTIAL_SAFETY_PROMPT);
    }
  });
});
