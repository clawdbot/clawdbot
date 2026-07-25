// Control UI tests cover canonical and legacy thinking-level normalization.
import { describe, expect, it } from "vitest";
import {
  formatThinkingOverrideLabel,
  normalizeThinkLevel,
  resolveChatThinkingSelectState,
  resolveThinkingLevelInput,
} from "./thinking.ts";

describe("chat thinking helpers", () => {
  it("keeps literal Ultra distinct from the legacy ultrathink alias", () => {
    expect(normalizeThinkLevel("ultra")).toBe("ultra");
    expect(normalizeThinkLevel("Ultra")).toBe("ultra");
    expect(normalizeThinkLevel("ultrathink")).toBe("high");
    expect(formatThinkingOverrideLabel("ultra")).toBe("Ultra");
  });

  it("accepts Ultra when the gateway advertises it for the session", () => {
    expect(
      resolveThinkingLevelInput(
        "ultra",
        {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          thinkingLevels: [{ id: "ultra", label: "Ultra" }],
        },
        undefined,
      ),
    ).toBe("ultra");
  });

  it("does not promote an unsupported persisted Ultra override into a slider stop", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [],
      sessionKey: "agent:main:main",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            thinkingLevel: "ultra",
            thinkingLevels: [{ id: "max", label: "max" }],
          },
        ],
      },
    });

    expect(state.currentOverride).toBe("ultra");
    expect(state.options.map((option) => option.value)).toEqual(["max"]);
  });

  it("does not inherit same-model thinking levels from a different runtime", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [],
      sessionKey: "agent:main:main",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: {
          modelProvider: "openai",
          model: "gpt-5.6-luna",
          contextTokens: null,
          agentRuntime: { id: "openclaw", source: "model" },
          thinkingLevels: [
            { id: "max", label: "max" },
            { id: "ultra", label: "ultra" },
          ],
        },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            modelProvider: "openai",
            model: "gpt-5.6-luna",
            agentRuntime: { id: "codex", source: "session-key" },
          },
        ],
      },
    });

    expect(state.options.map((option) => option.value)).not.toContain("ultra");
  });
});
