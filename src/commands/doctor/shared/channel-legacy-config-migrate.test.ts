import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Channel legacy config migration tests cover doctor repair of old channel config shapes.
import type { OpenClawConfig } from "../../../config/types.js";

const { applyPluginDoctorCompatibilityMigrations, collectRelevantDoctorPluginIds } = vi.hoisted(
  () => ({
    applyPluginDoctorCompatibilityMigrations: vi.fn(),
    collectRelevantDoctorPluginIds: vi.fn(),
  }),
);
const loadBundledChannelDoctorContractApi = vi.hoisted(() => vi.fn());
const getBootstrapChannelPlugin = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/doctor-contract-registry.js", () => ({
  applyPluginDoctorCompatibilityMigrations: (...args: unknown[]) =>
    applyPluginDoctorCompatibilityMigrations(...args),
  collectRelevantDoctorPluginIds: (...args: unknown[]) => collectRelevantDoctorPluginIds(...args),
}));

vi.mock("../../../channels/plugins/doctor-contract-api.js", () => ({
  loadBundledChannelDoctorContractApi: (...args: unknown[]) =>
    loadBundledChannelDoctorContractApi(...args),
}));

vi.mock("../../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (...args: unknown[]) => getBootstrapChannelPlugin(...args),
}));

let applyChannelDoctorCompatibilityMigrations: typeof import("./channel-legacy-config-migrate.js").applyChannelDoctorCompatibilityMigrations;

beforeAll(async () => {
  // Commands runs on the shared non-isolated worker, so reload after installing
  // this file's mock to avoid inheriting a cached real registry import.
  vi.resetModules();
  ({ applyChannelDoctorCompatibilityMigrations } =
    await import("./channel-legacy-config-migrate.js"));
});

beforeEach(() => {
  applyPluginDoctorCompatibilityMigrations.mockReset();
  collectRelevantDoctorPluginIds.mockReset();
  loadBundledChannelDoctorContractApi.mockReset();
  getBootstrapChannelPlugin.mockReset();
});

function firstMigrationCall() {
  return applyPluginDoctorCompatibilityMigrations.mock.calls[0];
}

describe("bundled channel legacy config migrations", () => {
  it("only renames heartbeat blocks that use the common visibility shape", () => {
    collectRelevantDoctorPluginIds.mockReturnValue([]);
    loadBundledChannelDoctorContractApi.mockReturnValue({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
        config: cfg,
        changes: [],
      }),
    });

    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        feishu: {
          heartbeat: { visibility: "hidden", intervalMs: 1000 },
          accounts: {
            work: { heartbeat: { visibility: "visible" } },
            empty: { heartbeat: {} },
          },
        },
        slack: {
          heartbeat: { showOk: true },
          accounts: {
            work: { heartbeat: { showAlerts: false } },
          },
        },
      },
    });

    const channels = result.next.channels as Record<string, Record<string, unknown>>;
    const feishu = channels.feishu ?? {};
    const feishuAccounts = feishu.accounts as Record<string, Record<string, unknown>>;
    expect(feishu.heartbeat).toEqual({ visibility: "hidden", intervalMs: 1000 });
    expect(feishuAccounts.work?.heartbeat).toEqual({ visibility: "visible" });
    expect(feishuAccounts.empty?.heartbeat).toEqual({});
    const slack = channels.slack ?? {};
    const slackAccounts = slack.accounts as Record<string, Record<string, unknown>>;
    expect(slack.heartbeat).toBeUndefined();
    expect(slack.heartbeatVisibility).toEqual({ showOk: true });
    expect(slackAccounts.work?.heartbeatVisibility).toEqual({ showAlerts: false });
  });

  it("prefers bundled channel doctor contract normalizers before plugin registry fallback", () => {
    collectRelevantDoctorPluginIds.mockReturnValueOnce([]);
    loadBundledChannelDoctorContractApi.mockImplementation((channelId: string) =>
      channelId === "slack"
        ? {
            normalizeCompatibilityConfig: ({
              cfg,
            }: {
              cfg: { channels?: { slack?: Record<string, unknown> } };
            }) => ({
              config: {
                ...cfg,
                channels: {
                  ...cfg.channels,
                  slack: {
                    ...cfg.channels?.slack,
                    normalizedByBundledContract: true,
                  },
                },
              },
              changes: ["Normalized channels.slack via bundled doctor contract."],
            }),
          }
        : undefined,
    );
    getBootstrapChannelPlugin.mockReturnValue(undefined);

    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        slack: {
          streaming: true,
        },
      },
    });

    expect(applyPluginDoctorCompatibilityMigrations).not.toHaveBeenCalled();
    expect(loadBundledChannelDoctorContractApi).toHaveBeenCalledWith("slack");
    const nextChannels = (result.next.channels ?? {}) as {
      slack?: Record<string, unknown>;
    };
    expect(nextChannels.slack?.streaming).toBe(true);
    expect(nextChannels.slack?.normalizedByBundledContract).toBe(true);
    expect(result.changes).toEqual(["Normalized channels.slack via bundled doctor contract."]);
  });

  it("normalizes legacy private-network aliases exposed through bundled contract surfaces", () => {
    collectRelevantDoctorPluginIds.mockReturnValueOnce(["mattermost"]);
    loadBundledChannelDoctorContractApi.mockReturnValue(undefined);
    getBootstrapChannelPlugin.mockReturnValue(undefined);
    applyPluginDoctorCompatibilityMigrations.mockReturnValueOnce({
      config: {
        channels: {
          mattermost: {
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            accounts: {
              work: {
                network: {
                  dangerouslyAllowPrivateNetwork: false,
                },
              },
            },
          },
        },
      },
      changes: [
        "Moved channels.mattermost.allowPrivateNetwork → channels.mattermost.network.dangerouslyAllowPrivateNetwork (true).",
        "Moved channels.mattermost.accounts.work.allowPrivateNetwork → channels.mattermost.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
      ],
    });

    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        mattermost: {
          allowPrivateNetwork: true,
          accounts: {
            work: {
              allowPrivateNetwork: false,
            },
          },
        },
      },
    });

    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledOnce();
    const migrationCall = firstMigrationCall();
    expect(typeof migrationCall?.[0]).toBe("object");
    expect(migrationCall?.[1]?.config).toStrictEqual({
      channels: {
        mattermost: {
          allowPrivateNetwork: true,
          accounts: {
            work: {
              allowPrivateNetwork: false,
            },
          },
        },
      },
    });
    expect(migrationCall?.[1]?.pluginIds).toStrictEqual(["mattermost"]);

    const nextChannels = (result.next.channels ?? {}) as {
      mattermost?: Record<string, unknown>;
    };

    expect(nextChannels.mattermost).toEqual({
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
      accounts: {
        work: {
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
        },
      },
    });
    expect(result.changes).toStrictEqual([
      "Moved channels.mattermost.allowPrivateNetwork → channels.mattermost.network.dangerouslyAllowPrivateNetwork (true).",
      "Moved channels.mattermost.accounts.work.allowPrivateNetwork → channels.mattermost.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
    ]);
  });

  it("applies plugin doctor normalizers for configured non-channel plugin entries", () => {
    collectRelevantDoctorPluginIds.mockReturnValueOnce(["lossless-claw"]);
    applyPluginDoctorCompatibilityMigrations.mockReturnValueOnce({
      config: {
        plugins: {
          entries: {
            "lossless-claw": {
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai-codex/gpt-5.4-mini"],
              },
            },
          },
        },
      },
      changes: ["Configured plugins.entries.lossless-claw.llm.allowedModels."],
    });

    const config = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "openai-codex/gpt-5.4-mini",
            },
          },
        },
      },
    };
    const result = applyChannelDoctorCompatibilityMigrations(config);

    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledOnce();
    const migrationCall = firstMigrationCall();
    expect(typeof migrationCall?.[0]).toBe("object");
    expect(migrationCall?.[1]).toStrictEqual({
      config,
      pluginIds: ["lossless-claw"],
    });
    expect(result.changes).toEqual(["Configured plugins.entries.lossless-claw.llm.allowedModels."]);
  });
});
