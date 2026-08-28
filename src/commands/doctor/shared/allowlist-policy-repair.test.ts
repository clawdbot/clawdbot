// Allowlist policy repair tests cover doctor repair of unsafe or stale allowlist policy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SignalAccountConfig } from "../../../config/types.signal.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./allowlist-policy-repair.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

// The real lookup materializes a bundled channel plugin to read declared doctor
// capabilities. These mirror the values the plugins actually declare (matrix is
// "nestedOnly"; signal declares none and takes the "topOnly" default) so the repair
// logic is exercised unchanged without paying plugin load per call.
vi.mock("../channel-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel-capabilities.js")>();
  return {
    ...actual,
    getDoctorChannelCapabilities: (channelName?: string) => ({
      dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: true,
      warnOnEmptyGroupSenderAllowlist: true,
    }),
  };
});

describe("doctor allowlist-policy repair", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
  });

  it.each([
    { name: "inherited policy", rootAllowFrom: [], account: {}, recovered: true },
    {
      name: "inherited allowlist",
      rootAllowFrom: ["root-sender"],
      account: { dmPolicy: "allowlist" },
      recovered: false,
    },
    {
      name: "explicit empty allowlist",
      rootAllowFrom: ["root-sender"],
      account: { allowFrom: [] },
      recovered: true,
    },
    {
      name: "explicit pairing override",
      rootAllowFrom: [],
      account: { dmPolicy: "pairing" },
      recovered: false,
    },
  ] satisfies Array<{
    name: string;
    rootAllowFrom: string[];
    account: SignalAccountConfig;
    recovered: boolean;
  }>)(
    "resolves $name before recovering account senders",
    async ({ rootAllowFrom, account, recovered }) => {
      readChannelAllowFromStoreMock.mockImplementation(
        async (_channel: string, _env: NodeJS.ProcessEnv, accountId: string) =>
          accountId === "work" ? ["account-sender"] : [],
      );
      const cfg: OpenClawConfig = {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            allowFrom: rootAllowFrom,
            accounts: { work: account },
          },
        },
      };

      const result = await maybeRepairAllowlistPolicyAllowFrom(cfg);

      expect(result.config.channels?.signal).toEqual({
        dmPolicy: "allowlist",
        allowFrom: rootAllowFrom,
        accounts: {
          work: recovered ? { ...account, allowFrom: ["account-sender"] } : account,
        },
      });
      expect(result.changes).toEqual(
        recovered
          ? [
              '- channels.signal.accounts.work.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
            ]
          : [],
      );
    },
  );

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
