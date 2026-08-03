import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import { markAuthProfileSuccess } from "../auth-profiles.js";
import { markEmbeddedRunAuthProfileSuccess } from "./run/auth-profile-success.js";
import { resolveInitialThinkLevel } from "./run/runtime-resolution.js";
import { copyAttemptDeliveryState } from "./run/terminal-resolution.js";

vi.mock("../auth-profiles.js", () => ({
  markAuthProfileSuccess: vi.fn(),
}));

const mockedMarkAuthProfileSuccess = vi.mocked(markAuthProfileSuccess);

describe("markEmbeddedRunAuthProfileSuccess", () => {
  beforeEach(() => {
    mockedMarkAuthProfileSuccess.mockReset();
  });

  it("does not wait for post-run success bookkeeping", () => {
    const pendingSuccess = new Promise<void>(() => {});
    mockedMarkAuthProfileSuccess.mockReturnValueOnce(pendingSuccess);

    const result = markEmbeddedRunAuthProfileSuccess({
      profileId: "openai:test-profile",
      profileStore: { version: 1, profiles: {} } as AuthProfileStore,
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(result).toBeUndefined();
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledOnce();
  });
});

describe("overflow loop owner policies", () => {
  it("uses provider policy for a configless MiniMax-M3 run", () => {
    expect(
      resolveInitialThinkLevel({
        config: undefined,
        provider: "minimax",
        modelId: "MiniMax-M3",
        model: { reasoning: true },
      }),
    ).toBe("adaptive");
  });

  it("propagates deterministic approval delivery", () => {
    expect(
      copyAttemptDeliveryState({
        didSendDeterministicApprovalPrompt: true,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      } as never).didSendDeterministicApprovalPrompt,
    ).toBe(true);
  });
});
