import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRepairAllowlistPolicyAllowFrom } from "./allowlist-policy-repair.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

describe("doctor allowlist-policy repair", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
  });

  it("restores matrix dm allowFrom from the pairing store into the nested path", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["@alice:example.org"]);

    const result = await maybeRepairAllowlistPolicyAllowFrom({
      channels: {
        matrix: {
          dm: {
            policy: "allowlist",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.matrix.dm.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config.channels?.matrix?.allowFrom).toBeUndefined();
    expect(result.config.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org"]);
  });

  it("skips disabled channel and account entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["alice"]);

    const result = await maybeRepairAllowlistPolicyAllowFrom({
      channels: {
        telegram: {
          enabled: false,
          dmPolicy: "allowlist",
        },
        signal: {
          accounts: {
            disabled: { enabled: false, dmPolicy: "allowlist" },
          },
        },
      },
    });

    expect(result).toEqual({
      config: {
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "allowlist",
          },
          signal: {
            accounts: {
              disabled: { enabled: false, dmPolicy: "allowlist" },
            },
          },
        },
      },
      changes: [],
    });
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
