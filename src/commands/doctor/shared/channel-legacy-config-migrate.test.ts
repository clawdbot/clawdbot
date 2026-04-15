import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const applyPluginDoctorCompatibilityMigrations = vi.hoisted(() => vi.fn());
const loadBundledChannelDoctorContractApi = vi.hoisted(() => vi.fn());
const getBootstrapChannelPlugin = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/doctor-contract-registry.js", () => ({
  applyPluginDoctorCompatibilityMigrations: (...args: unknown[]) =>
    applyPluginDoctorCompatibilityMigrations(...args),
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
  loadBundledChannelDoctorContractApi.mockReset();
  getBootstrapChannelPlugin.mockReset();
});

describe("bundled channel legacy config migrations", () => {
  it("prefers bundled channel doctor contract normalizers before plugin registry fallback", () => {
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
    expect(nextChannels.slack).toMatchObject({
      streaming: true,
      normalizedByBundledContract: true,
    });
    expect(result.changes).toEqual(["Normalized channels.slack via bundled doctor contract."]);
  });

  it("normalizes legacy private-network aliases exposed through bundled contract surfaces", () => {
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

    expect(applyPluginDoctorCompatibilityMigrations).toHaveBeenCalledWith(expect.any(Object), {
      pluginIds: ["mattermost"],
    });

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
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.mattermost.allowPrivateNetwork → channels.mattermost.network.dangerouslyAllowPrivateNetwork (true).",
        "Moved channels.mattermost.accounts.work.allowPrivateNetwork → channels.mattermost.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
      ]),
    );
  });
});
