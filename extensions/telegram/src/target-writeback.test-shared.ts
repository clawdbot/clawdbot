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

    it("preserves topic suffix style in writeback target", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel:topic:9",
              },
            },
          },
        },
        writeOptions: {},
      });
      loadCronStore.mockResolvedValue({ version: 1, jobs: [] });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "t.me/mychannel:topic:9",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const [writtenConfig, writeOptions] = requireWriteConfigCall();
      expect(writtenConfig.channels?.telegram?.defaultTo).toBe("-100123:topic:9");
      expect(writeOptions).toEqual({});
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
