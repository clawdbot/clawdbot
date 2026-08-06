import { describe, expect, it } from "vitest";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "./session-runtime-compat.js";

describe("resolvePersistedSessionRuntimeId", () => {
  it("lets a locked harness outrank a conflicting persisted runtime override", () => {
    expect(
      resolvePersistedSessionRuntimeId({
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: true,
      }),
    ).toBe("codex");
  });

  it("uses the override when the historical harness is not locked", () => {
    expect(
      resolvePersistedSessionRuntimeId({
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
        modelSelectionLocked: false,
      }),
    ).toBe("openclaw");
  });

  it("filters default overrides before falling back to the persisted harness", () => {
    expect(
      resolvePersistedSessionRuntimeId({
        agentHarnessId: "codex-app-server",
        agentRuntimeOverride: "default",
      }),
    ).toBe("codex");
  });
});

describe("resolveSessionRuntimeOverrideForProvider", () => {
  it("keeps a locked harness across a conflicting provider runtime alias", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "anthropic",
        entry: {
          agentHarnessId: "codex",
          agentRuntimeOverride: "claude-cli",
          modelSelectionLocked: true,
        },
      }),
    ).toBe("codex");
  });

  it("does not revive an unlocked historical harness for a future turn", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "openai",
        entry: {
          agentHarnessId: "codex",
          modelSelectionLocked: false,
        },
      }),
    ).toBeUndefined();
  });
});
