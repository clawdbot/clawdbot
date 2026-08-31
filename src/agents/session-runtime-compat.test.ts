import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  resolveManualCompactionCliTarget,
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

describe("resolveManualCompactionCliTarget", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        ] as never,
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("recovers an implicit CLI runtime from its unique compatible binding", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {
          cliSessionBindings: {
            "claude-cli": { sessionId: "native-claude-session" },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "claude-cli",
      cliSessionBinding: { sessionId: "native-claude-session" },
      cliSessionId: "native-claude-session",
    });
  });

  it("uses setup metadata when the runtime registry is scoped elsewhere", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? ({
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            } as never)
          : undefined,
    });
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        cfg: {} as OpenClawConfig,
        entry: {
          cliSessionBindings: {
            "claude-cli": { sessionId: "native-claude-session" },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "claude-cli",
      cliSessionBinding: { sessionId: "native-claude-session" },
      cliSessionId: "native-claude-session",
    });
  });

  it("passes config when resolving an explicit setup-registered runtime binding", () => {
    const cfg = { plugins: { entries: { anthropic: { enabled: true } } } } as OpenClawConfig;
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config === cfg
          ? ({
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            } as never)
          : undefined,
    });

    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        cfg,
        entry: {
          agentRuntimeOverride: "claude-cli",
          cliSessionBindings: {
            "claude-cli": { sessionId: "native-claude-session" },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "claude-cli",
      cliSessionBinding: { sessionId: "native-claude-session" },
      cliSessionId: "native-claude-session",
    });
  });

  it("does not infer a CLI runtime without its native binding", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {},
      }),
    ).toEqual({});
  });

  it("does not choose between multiple compatible native bindings", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
          {
            id: "other-claude-cli",
            modelProvider: "anthropic",
            config: { command: "other-claude" },
            bundleMcp: false,
          },
        ] as never,
    });
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {
          cliSessionBindings: {
            "claude-cli": { sessionId: "claude-session" },
            "other-claude-cli": { sessionId: "other-session" },
          },
        },
      }),
    ).toEqual({});
  });

  it("does not reuse a recorded CLI runtime after a provider switch", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "openai",
        entry: {
          cliSessionBindings: {
            "claude-cli": { sessionId: "stale-claude-session" },
          },
        },
      }),
    ).toEqual({});
  });

  it("does not reuse an unlocked historical harness binding after a provider switch", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "openai",
        entry: {
          agentHarnessId: "claude-cli",
          modelSelectionLocked: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "stale-claude-session" },
          },
        },
      }),
    ).toEqual({});
  });

  it("keeps an explicit runtime authoritative when it has no binding yet", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {
          agentRuntimeOverride: "claude-cli",
          cliSessionBindings: {
            "other-cli": { sessionId: "other-session" },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "claude-cli",
      cliSessionBinding: undefined,
      cliSessionId: undefined,
    });
  });

  it("preserves the selected auth profile on the native binding", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "native-claude-session",
              authProfileId: "anthropic:subscription",
            },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "claude-cli",
      cliSessionBinding: {
        sessionId: "native-claude-session",
        authProfileId: "anthropic:subscription",
      },
      cliSessionId: "native-claude-session",
    });
  });
});
