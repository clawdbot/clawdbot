import { describe, expect, it, vi } from "vitest";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";

const applyPluginDoctorCompatibilityMigrations = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/doctor-contract-registry.js", () => ({
  applyPluginDoctorCompatibilityMigrations: (...args: unknown[]) =>
    applyPluginDoctorCompatibilityMigrations(...args),
}));

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
