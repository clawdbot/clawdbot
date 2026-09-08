import { describe, expect, it } from "vitest";
import { createLegacyPrivateNetworkDoctorContract } from "./legacy-private-network-migration.js";

const { normalizeCompatibilityConfig } = createLegacyPrivateNetworkDoctorContract({
  channelKey: "example",
});

describe("legacy private-network channel traversal", () => {
  it("preserves root-first diagnostics, canonical precedence, and untouched scopes", () => {
    const kept = { enabled: false };
    const other = { enabled: true };
    const cfg = {
      channels: {
        example: {
          allowPrivateNetwork: true,
          network: { dangerouslyAllowPrivateNetwork: false },
          accounts: {
            first: { allowPrivateNetwork: false },
            kept,
            invalid: null,
            last: { allowPrivateNetwork: true },
          },
        },
        other,
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).toEqual({
      channels: {
        example: {
          network: { dangerouslyAllowPrivateNetwork: false },
          accounts: {
            first: { network: { dangerouslyAllowPrivateNetwork: false } },
            kept,
            invalid: null,
            last: { network: { dangerouslyAllowPrivateNetwork: true } },
          },
        },
        other,
      },
    });
    expect(result.changes).toEqual([
      "Moved channels.example.allowPrivateNetwork → channels.example.network.dangerouslyAllowPrivateNetwork (false).",
      "Moved channels.example.accounts.first.allowPrivateNetwork → channels.example.accounts.first.network.dangerouslyAllowPrivateNetwork (false).",
      "Moved channels.example.accounts.last.allowPrivateNetwork → channels.example.accounts.last.network.dangerouslyAllowPrivateNetwork (true).",
    ]);
    expect(cfg.channels.example.allowPrivateNetwork).toBe(true);
    expect(cfg.channels.example.accounts.first.allowPrivateNetwork).toBe(false);
    expect(result.config.channels?.other).toBe(other);

    const repeated = normalizeCompatibilityConfig({ cfg: result.config });
    expect(repeated.config).toBe(result.config);
    expect(repeated.changes).toEqual([]);
  });

  it("does not migrate an array-shaped channel map through a numeric channel key", () => {
    const cfg = { channels: [{ allowPrivateNetwork: true }] };
    const contract = createLegacyPrivateNetworkDoctorContract({ channelKey: "0" });

    const result = contract.normalizeCompatibilityConfig({ cfg });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("keeps an array account map intact while migrating the channel root", () => {
    const accounts = [{ allowPrivateNetwork: true }];
    const cfg = { channels: { example: { allowPrivateNetwork: false, accounts } } };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).toEqual({
      channels: {
        example: { accounts, network: { dangerouslyAllowPrivateNetwork: false } },
      },
    });
    expect(result.changes).toEqual([
      "Moved channels.example.allowPrivateNetwork → channels.example.network.dangerouslyAllowPrivateNetwork (false).",
    ]);
  });
});
