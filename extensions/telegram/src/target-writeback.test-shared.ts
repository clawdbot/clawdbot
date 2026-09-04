// Telegram plugin module implements target writeback shared behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

const readConfigFileSnapshotForWrite: AsyncUnknownMock = vi.fn();
const writeConfigFile: AsyncUnknownMock = vi.fn();
const replaceConfigFile: AsyncUnknownMock = vi.fn(async (params: unknown) => {
  const record = params as { nextConfig?: unknown; writeOptions?: unknown };
  await writeConfigFile(record.nextConfig, record.writeOptions);
});
const loadCronStore: AsyncUnknownMock = vi.fn();
const resolveCronStorePath: UnknownMock = vi.fn();
const saveCronStore: AsyncUnknownMock = vi.fn();

type TelegramConfigWrite = {
  channels?: {
    telegram?: {
      defaultTo?: string;
      accounts?: Record<string, { defaultTo?: string }>;
    };
  };
};

type CronStoreWrite = {
  version: number;
  jobs: Array<{ id: string; delivery: { channel: string; to: string } }>;
};

const scopedTargetWritebackCases = [
  {
    name: "channel Direct Messages topic",
    rawTarget: "@mychannel:direct-topic:77",
    matchingTarget: "t.me/MyChannel:direct-topic:77",
    resolvedTarget: "-100123:direct-topic:77",
    unmatchedTargets: [
      "@mychannel",
      "@mychannel:direct-topic:88",
      "@mychannel:topic:77",
      "@mychannel:77",
      "@otherchannel:direct-topic:77",
    ],
  },
  {
    name: "explicit forum topic",
    rawTarget: "@mychannel:topic:77",
    matchingTarget: "t.me/MyChannel:77",
    resolvedTarget: "-100123:topic:77",
    unmatchedTargets: ["@mychannel", "@mychannel:direct-topic:77", "@mychannel:topic:88"],
  },
  {
    name: "shorthand forum topic",
    rawTarget: "@mychannel:77",
    matchingTarget: "t.me/MyChannel:topic:77",
    resolvedTarget: "-100123:77",
    unmatchedTargets: ["@mychannel", "@mychannel:direct-topic:77", "@mychannel:88"],
  },
  {
    name: "unthreaded target",
    rawTarget: "t.me/mychannel",
    matchingTarget: "@MyChannel",
    resolvedTarget: "-100123",
    unmatchedTargets: [
      "@mychannel:direct-topic:77",
      "@mychannel:direct-topic:88",
      "@mychannel:topic:77",
      "@mychannel:77",
    ],
  },
] as const;

vi.mock("openclaw/plugin-sdk/config-mutation", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-mutation")>(
    "openclaw/plugin-sdk/config-mutation",
  );
  return {
    ...actual,
    readConfigFileSnapshotForWrite,
    replaceConfigFile,
    writeConfigFile,
  };
});

vi.mock("openclaw/plugin-sdk/cron-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/cron-store-runtime")>(
    "openclaw/plugin-sdk/cron-store-runtime",
  );
  return {
    ...actual,
    loadCronStore,
    resolveCronStorePath,
    saveCronStore,
  };
});

export function installMaybePersistResolvedTelegramTargetTests(params?: {
  includeGatewayScopeCases?: boolean;
}) {
  describe("maybePersistResolvedTelegramTarget", () => {
    let maybePersistResolvedTelegramTarget: typeof import("./target-writeback.js").maybePersistResolvedTelegramTarget;

    function requireWriteConfigCall(index = 0): [TelegramConfigWrite, Record<string, unknown>] {
      const call = writeConfigFile.mock.calls[index] as
        | [TelegramConfigWrite, Record<string, unknown>]
        | undefined;
      if (!call) {
        throw new Error(`expected writeConfigFile call #${index + 1}`);
      }
      return call;
    }

    function requireSaveCronStoreCall(index = 0): [string, CronStoreWrite] {
      const call = saveCronStore.mock.calls[index] as [string, CronStoreWrite] | undefined;
      if (!call) {
        throw new Error(`expected saveCronStore call #${index + 1}`);
      }
      return call;
    }

    beforeAll(async () => {
      ({ maybePersistResolvedTelegramTarget } = await import("./target-writeback.js"));
    });

    beforeEach(() => {
      readConfigFileSnapshotForWrite.mockReset();
      replaceConfigFile.mockClear();
      writeConfigFile.mockReset();
      loadCronStore.mockReset();
      resolveCronStorePath.mockReset();
      saveCronStore.mockReset();
      resolveCronStorePath.mockReturnValue("/tmp/cron/jobs.json");
    });

    it("skips writeback when target is already numeric", async () => {
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "-100123",
        resolvedChatId: "-100123",
        gatewayClientScopes: ["operator.admin"],
      });

      expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
      expect(loadCronStore).not.toHaveBeenCalled();
    });

    if (params?.includeGatewayScopeCases) {
      it("skips config and cron writeback for gateway callers missing operator.admin", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: ["operator.write"],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });

      it("does not let internal writeback override non-admin gateway scopes", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: ["operator.write"],
          trustedInternalWriteback: true,
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });

      it("skips config and cron writeback for gateway callers with an empty scope set", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: [],
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });

      it("skips config and cron writeback when gateway scopes are missing", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: undefined,
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });

      it("writes back for gateway callers with operator.admin", async () => {
        readConfigFileSnapshotForWrite.mockResolvedValue({
          snapshot: {
            config: {
              channels: {
                telegram: {
                  defaultTo: "t.me/mychannel",
                },
              },
            },
          },
          writeOptions: {},
        });
        loadCronStore.mockResolvedValue({
          version: 1,
          jobs: [{ id: "a", delivery: { channel: "telegram", to: "t.me/mychannel" } }],
        });

        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
          gatewayClientScopes: ["operator.admin"],
        });

        expect(writeConfigFile).toHaveBeenCalledTimes(1);
        expect(saveCronStore).toHaveBeenCalledTimes(1);
      });
    }

    it("writes back matching config and cron targets", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel",
                accounts: {
                  alerts: {
                    defaultTo: "@mychannel",
                  },
                },
              },
            },
          },
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      loadCronStore.mockResolvedValue({
        version: 1,
        jobs: [
          { id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } },
          { id: "b", delivery: { channel: "slack", to: "C123" } },
        ],
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {
          cron: { store: "/tmp/cron/jobs.json" },
        } as OpenClawConfig,
        rawTarget: "t.me/mychannel",
        resolvedChatId: "-100123",
        gatewayClientScopes: undefined,
        trustedInternalWriteback: true,
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const [writtenConfig, writeOptions] = requireWriteConfigCall();
      expect(writtenConfig.channels?.telegram?.defaultTo).toBe("-100123");
      expect(writtenConfig.channels?.telegram?.accounts?.alerts?.defaultTo).toBe("-100123");
      expect(writeOptions.expectedConfigPath).toBe("/tmp/openclaw.json");
      expect(saveCronStore).toHaveBeenCalledTimes(1);
      const [cronPath, cronStore] = requireSaveCronStoreCall();
      expect(cronPath).toBe("/tmp/cron/jobs.json");
      expect(cronStore.jobs).toEqual([
        { id: "a", delivery: { channel: "telegram", to: "-100123" } },
        { id: "b", delivery: { channel: "slack", to: "C123" } },
      ]);
    });

    it.each(
      scopedTargetWritebackCases.flatMap((testCase) =>
        (["config", "cron"] as const).map((surface) => ({
          name: testCase.name,
          surface,
          testCase,
        })),
      ),
    )("rewrites only matching $name $surface targets", async ({ surface, testCase }) => {
      const unmatchedAccounts = Object.fromEntries(
        testCase.unmatchedTargets.map((target, index) => [`other${index}`, { defaultTo: target }]),
      );
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: testCase.matchingTarget,
                accounts: unmatchedAccounts,
              },
            },
          },
        },
        writeOptions: {},
      });
      loadCronStore.mockResolvedValue({
        version: 1,
        jobs: [testCase.matchingTarget, ...testCase.unmatchedTargets].map((target, index) => ({
          id: String(index),
          delivery: { channel: "telegram", to: target },
        })),
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: testCase.rawTarget,
        resolvedChatId: "-100123",
        gatewayClientScopes: undefined,
        trustedInternalWriteback: true,
      });

      const persistedTargets =
        surface === "config"
          ? [
              requireWriteConfigCall()[0].channels?.telegram?.defaultTo,
              ...Object.values(requireWriteConfigCall()[0].channels?.telegram?.accounts ?? {}).map(
                (account) => account.defaultTo,
              ),
            ]
          : requireSaveCronStoreCall()[1].jobs.map((job) => job.delivery.to);

      expect(persistedTargets).toEqual([testCase.resolvedTarget, ...testCase.unmatchedTargets]);
    });

    it("matches username targets case-insensitively", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "https://t.me/mychannel",
              },
            },
          },
        },
        writeOptions: {},
      });
      loadCronStore.mockResolvedValue({
        version: 1,
        jobs: [{ id: "a", delivery: { channel: "telegram", to: "https://t.me/mychannel" } }],
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "@MyChannel",
        resolvedChatId: "-100123",
        gatewayClientScopes: undefined,
        trustedInternalWriteback: true,
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const [writtenConfig, writeOptions] = requireWriteConfigCall();
      expect(writtenConfig.channels?.telegram?.defaultTo).toBe("-100123");
      expect(writeOptions).toEqual({});
      expect(saveCronStore).toHaveBeenCalledTimes(1);
      const [cronPath, cronStore] = requireSaveCronStoreCall();
      expect(cronPath).toBe("/tmp/cron/jobs.json");
      expect(cronStore.jobs).toEqual([
        { id: "a", delivery: { channel: "telegram", to: "-100123" } },
      ]);
    });
  });
}
