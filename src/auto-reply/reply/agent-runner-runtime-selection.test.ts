import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions.js";

describe("resolveSessionRuntimeOverrideForProvider", () => {
  it("honors an explicit OpenClaw override for OpenAI", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "openai",
        entry: { agentRuntimeOverride: "openclaw" } as SessionEntry,
      }),
    ).toBe("openclaw");
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("ignores unsupported session runtime pins", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "openai",
        entry: { agentRuntimeOverride: "unsupported-runtime" },
      }),
    ).toBeUndefined();
  });

  it.each([
    { provider: "openai", expected: "codex" },
    { provider: "codex", expected: "codex" },
    { provider: "anthropic", expected: undefined },
  ])("resolves Codex runtime compatibility for $provider", ({ provider, expected }) => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider,
        entry: { agentRuntimeOverride: "codex" },
      }),
    ).toBe(expected);
  });

  it("does not treat an observed harness as a future-turn override", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "anthropic",
        entry: { agentHarnessId: "codex" },
      }),
    ).toBeUndefined();
  });

  it("keeps a locked harness pin ahead of a conflicting runtime override", () => {
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
  it("keeps CLI runtime pins only when the runtime serves the selected provider", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
    });
    const cfg = {};

    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "anthropic",
        entry: { agentRuntimeOverride: "claude-cli" },
        cfg,
      }),
    ).toBe("claude-cli");
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "openai",
        entry: { agentRuntimeOverride: "claude-cli" },
        cfg,
      }),
    ).toBeUndefined();
  });
});
