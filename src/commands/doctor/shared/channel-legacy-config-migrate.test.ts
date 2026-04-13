import { beforeAll, describe, expect, it, vi } from "vitest";

const applyPluginDoctorCompatibilityMigrations = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/doctor-contract-registry.js", () => ({
  applyPluginDoctorCompatibilityMigrations: (...args: unknown[]) =>
    applyPluginDoctorCompatibilityMigrations(...args),
}));

let applyChannelDoctorCompatibilityMigrations: typeof import("./channel-legacy-config-migrate.js").applyChannelDoctorCompatibilityMigrations;

beforeAll(async () => {
  // Commands runs on the shared non-isolated worker, so reload after installing
  // this file's mock to avoid inheriting a cached real registry import.
  vi.resetModules();
  ({ applyChannelDoctorCompatibilityMigrations } =
    await import("./channel-legacy-config-migrate.js"));
});

describe("bundled channel legacy config migrations", () => {
  it("normalizes legacy private-network aliases exposed through bundled contract surfaces", () => {
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
