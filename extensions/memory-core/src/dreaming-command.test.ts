// Memory Core tests cover dreaming command plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { handleDreamingCommand } from "./dreaming-command.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveStoredDreaming(config: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(config.plugins?.entries?.["memory-core"]);
  const pluginConfig = asRecord(entry?.config);
  return asRecord(pluginConfig?.dreaming) ?? {};
}

function createHarness(initialConfig: OpenClawConfig = {}) {
  let runtimeConfig: OpenClawConfig = initialConfig;

  const runtime = {
    config: {
      current: vi.fn(() => runtimeConfig),
      loadConfig: vi.fn(() => runtimeConfig),
      mutateConfigFile: vi.fn(async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
        const draft = structuredClone(runtimeConfig);
        mutate(draft);
        runtimeConfig = draft;
        return {
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: {},
          nextConfig: runtimeConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result: undefined,
        };
      }),
      replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
        runtimeConfig = nextConfig;
      }),
      writeConfigFile: vi.fn(async (nextConfig: OpenClawConfig) => {
        runtimeConfig = nextConfig;
      }),
    },
  } as unknown as OpenClawPluginApi["runtime"];

  const api = {
    runtime,
  } as unknown as OpenClawPluginApi;

  return {
    api,
    runtime,
    getRuntimeConfig: () => runtimeConfig,
  };
}

function createCommandContext(
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes" | "senderIsOwner">>,
): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config: {},
    gatewayClientScopes: overrides?.gatewayClientScopes,
    senderIsOwner: overrides?.senderIsOwner,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

async function runDreamingCommand(
  harness: ReturnType<typeof createHarness>,
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes" | "senderIsOwner">>,
) {
  return await handleDreamingCommand(harness.api, createCommandContext(args, overrides));
}

describe("memory-core /dreaming command", () => {
  it("shows phase explanations when invoked without args", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness);

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- implementation detail: each sweep runs light -> REM -> deep.");
    expect(result.text).toContain(
      "- deep is the only stage that writes durable entries to MEMORY.md.",
    );
  });

  it("blocks non-owner external channel callers from persisting dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "off");

    expect(result.text).toContain(
      "requires owner status for channel callers or operator.admin for gateway clients",
    );
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("allows owner external channel callers to persist global enablement", async () => {
    const harness = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                phases: {
                  deep: {
                    minScore: 0.9,
                  },
                },
                frequency: "0 */6 * * *",
              },
            },
          },
        },
      },
    });

    const result = await runDreamingCommand(harness, "off", {
      senderIsOwner: true,
    });

    expect(harness.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    const storedDreaming = resolveStoredDreaming(harness.getRuntimeConfig());
    expect(storedDreaming.enabled).toBe(false);
    expect(storedDreaming.frequency).toBe("0 */6 * * *");
    expect(result.text).toContain("Dreaming disabled.");
  });

  it("blocks unscoped gateway callers from persisting dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "off", {
      gatewayClientScopes: [],
    });

    expect(result.text).toContain(
      "requires owner status for channel callers or operator.admin for gateway clients",
    );
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("blocks write-scoped gateway callers from persisting dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "off", {
      gatewayClientScopes: ["operator.write"],
    });

    expect(result.text).toContain(
      "requires owner status for channel callers or operator.admin for gateway clients",
    );
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("allows admin-scoped gateway callers to persist dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "on", {
      gatewayClientScopes: ["operator.admin"],
    });

    expect(harness.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(harness.getRuntimeConfig()).enabled).toBe(true);
    expect(result.text).toContain("Dreaming enabled.");
  });

  it("returns status without mutating config", async () => {
    const harness = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                frequency: "15 */8 * * *",
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    });

    const result = await runDreamingCommand(harness, "status");

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- enabled: off (America/Los_Angeles)");
    expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
    expect(result.text).toContain("- promotion policy: score>=0.8, recalls>=3, uniqueQueries>=3");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness, "unknown-mode");

    expect(result.text).toContain("Usage: /dreaming status");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });
});
