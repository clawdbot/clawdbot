// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";
import { setAssistantAvatarOverride } from "./assistant-identity.ts";

describe("setAssistantAvatarOverride", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the assistant avatar locally and mirrors the user avatar pattern", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {};

    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    expect(state.assistantAvatar).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarSource).toBe("data:image/png;base64,YXZhdGFy");
    expect(state.assistantAvatarStatus).toBe("data");
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBe("data:image/png;base64,YXZhdGFy");
  });

  it("clears the local override", () => {
    const state: Parameters<typeof setAssistantAvatarOverride>[0] = {
      assistantAvatar: "data:image/png;base64,YXZhdGFy",
      assistantAvatarSource: "data:image/png;base64,YXZhdGFy",
      assistantAvatarStatus: "data",
    };
    setAssistantAvatarOverride(state, "data:image/png;base64,YXZhdGFy");

    setAssistantAvatarOverride(state, null);

    expect(state.assistantAvatarSource).toBeNull();
    expect(state.assistantAvatarStatus).toBeNull();
    expect(state.assistantAvatarReason).toBeNull();
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });
});
