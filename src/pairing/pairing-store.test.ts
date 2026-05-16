import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { withEnvAsync } from "../test-utils/env.js";

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: () => null,
}));

vi.mock("../infra/file-lock.js", () => ({
  withFileLock: async (_path: string, _options: unknown, fn: () => unknown) => await fn(),
}));

import {
  addChannelAllowFromStoreEntry,
  clearPairingAllowFromReadCacheForTest,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readLegacyChannelAllowFromStore,
  readLegacyChannelAllowFromStoreSync,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;
type RandomIntSync = (minOrMax: number, max?: number) => number;
type FileReadSpy = {
  readCount: () => number;
  mockRestore: () => void;
};

let randomIntSpy: MockInstance<RandomIntSync>;
let nextRandomInt = 0;

beforeAll(() => {
  fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fsSync.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearPairingAllowFromReadCacheForTest();
  nextRandomInt = 0;
  randomIntSpy ??= vi.spyOn(crypto, "randomInt") as unknown as MockInstance<RandomIntSync>;
  setDefaultRandomIntMock();
});

afterAll(() => {
  randomIntSpy?.mockRestore();
});

function setDefaultRandomIntMock() {
  randomIntSpy.mockImplementation((minOrMax: number, max?: number) => {
    const min = max === undefined ? 0 : minOrMax;
    const upper = max === undefined ? minOrMax : max;
    const span = Math.max(upper - min, 1);
    return min + (nextRandomInt++ % span);
  });
}

function requireFirstPairingRequest(
  requests: Awaited<ReturnType<typeof listChannelPairingRequests>>,
) {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) {
    throw new Error("expected pairing request");
  }
  return request;
}

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fsSync.mkdirSync(dir, { recursive: true });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => await fn(dir));
}

function writeJsonFixture(filePath: string, value: unknown) {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePairingFilePath(stateDir: string, channel: string) {
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}-pairing.json`);
}

function resolveAllowFromFilePath(stateDir: string, channel: string, accountId?: string) {
  const suffix = accountId ? `-${accountId}` : "";
  return path.join(resolveOAuthDir(process.env, stateDir), `${channel}${suffix}-allowFrom.json`);
}

function clearOAuthFixtures(stateDir: string) {
  clearPairingAllowFromReadCacheForTest();
  fsSync.rmSync(resolveOAuthDir(process.env, stateDir), { recursive: true, force: true });
}

async function writeAllowFromFixture(params: {
  stateDir: string;
  channel: string;
  allowFrom: string[];
  accountId?: string;
}) {
  writeJsonFixture(resolveAllowFromFilePath(params.stateDir, params.channel, params.accountId), {
    version: 1,
    allowFrom: params.allowFrom,
  });
}

async function createTelegramPairingRequest(accountId: string, id = "12345") {
  const created = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId,
    id,
  });
  expect(created.created).toBe(true);
  return created;
}

async function seedTelegramAllowFromFixtures(params: {
  stateDir: string;
  scopedAccountId: string;
  scopedAllowFrom: string[];
  legacyAllowFrom?: string[];
}) {
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    allowFrom: params.legacyAllowFrom ?? ["1001"],
  });
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: params.scopedAccountId,
    allowFrom: params.scopedAllowFrom,
  });
}

async function assertAllowFromCacheInvalidation(params: {
  stateDir: string;
  readAllowFrom: () => Promise<string[]>;
  readSpy: FileReadSpy;
}) {
  const first = await params.readAllowFrom();
  const second = await params.readAllowFrom();
  expect(first).toEqual(["1001"]);
  expect(second).toEqual(["1001"]);
  expect(params.readSpy.readCount()).toBe(1);

  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["10022"],
  });
  const third = await params.readAllowFrom();
  expect(third).toEqual(["10022"]);
  expect(params.readSpy.readCount()).toBe(2);
}

async function expectAccountScopedEntryIsolated(entry: string, accountId = "yy") {
  const accountScoped = await readChannelAllowFromStore("telegram", process.env, accountId);
  const channelScoped = await readLegacyChannelAllowFromStore("telegram");
  expect(accountScoped).toContain(entry);
  expect(channelScoped).not.toContain(entry);
}

async function expectAllowFromCacheInvalidationWithReadSpy(params: {
  stateDir: string;
  createReadSpy: (filePath: string) => FileReadSpy;
  readAllowFrom: () => Promise<string[]>;
}) {
  const filePath = resolveAllowFromFilePath(params.stateDir, "telegram", "yy");
  await writeAllowFromFixture({
    stateDir: params.stateDir,
    channel: "telegram",
    accountId: "yy",
    allowFrom: ["1001"],
  });
  clearPairingAllowFromReadCacheForTest();
  const readSpy = params.createReadSpy(filePath);
  try {
    await assertAllowFromCacheInvalidation({
      stateDir: params.stateDir,
      readAllowFrom: params.readAllowFrom,
      readSpy,
    });
  } finally {
    readSpy.mockRestore();
  }
}

function countFileReads(spy: { mock: { calls: unknown[][] } }, filePath: string): number {
  let count = 0;
  for (const [candidate] of spy.mock.calls) {
    if (candidate === filePath) {
      count++;
    }
  }
  return count;
}

async function seedDefaultAccountAllowFromFixture(stateDir: string) {
  await seedTelegramAllowFromFixtures({
    stateDir,
    scopedAccountId: DEFAULT_ACCOUNT_ID,
    scopedAllowFrom: ["1002"],
  });
}

async function withMockRandomInt(params: {
  initialValue?: number;
  sequence?: number[];
  fallbackValue?: number;
  run: () => Promise<void>;
}) {
  try {
    if (params.initialValue !== undefined) {
      randomIntSpy.mockReturnValue(params.initialValue);
    }

    if (params.sequence) {
      let idx = 0;
      randomIntSpy.mockImplementation(() => params.sequence?.[idx++] ?? params.fallbackValue ?? 1);
    }

    await params.run();
  } finally {
    setDefaultRandomIntMock();
  }
}

async function expectAllowFromReadConsistencyCase(params: {
  accountId?: string;
  expected: readonly string[];
  expectedLegacy?: readonly string[];
}) {
  const asyncScoped = await readChannelAllowFromStore("telegram", process.env, params.accountId);
  const syncScoped = readChannelAllowFromStoreSync("telegram", process.env, params.accountId);
  expect(asyncScoped).toEqual(params.expected);
  expect(syncScoped).toEqual(params.expected);
  if (params.expectedLegacy) {
    expect(await readLegacyChannelAllowFromStore("telegram")).toEqual(params.expectedLegacy);
    expect(readLegacyChannelAllowFromStoreSync("telegram")).toEqual(params.expectedLegacy);
  }
}

async function expectPendingPairingRequestsIsolatedByAccount(params: {
  sharedId: string;
  firstAccountId: string;
  secondAccountId: string;
}) {
  const first = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId: params.firstAccountId,
    id: params.sharedId,
  });
  const second = await upsertChannelPairingRequest({
    channel: "telegram",
    accountId: params.secondAccountId,
    id: params.sharedId,
  });

  expect(first.created).toBe(true);
  expect(second.created).toBe(true);
  expect(second.code).not.toBe(first.code);

  const firstList = await listChannelPairingRequests(
    "telegram",
    process.env,
    params.firstAccountId,
  );
  const secondList = await listChannelPairingRequests(
    "telegram",
    process.env,
    params.secondAccountId,
  );
  expect(requireFirstPairingRequest(firstList).code).toBe(first.code);
  expect(requireFirstPairingRequest(secondList).code).toBe(second.code);
}

describe("pairing store", () => {
  it("skips malformed persisted pairing requests while approving valid codes", async () => {
    await withTempStateDir(async (stateDir) => {
      const now = new Date("2026-05-16T05:20:00.000Z").toISOString();
      writeJsonFixture(resolvePairingFilePath(stateDir, "telegram"), {
        version: 1,
        requests: [
          {
            id: "bad-code",
            code: { nested: "bad" },
            createdAt: now,
            lastSeenAt: now,
          },
          {
            id: "1001",
            code: "ABCDEFGH",
            createdAt: now,
            lastSeenAt: now,
            meta: {
              accountId: "yy",
              ignored: { nested: "bad" },
            },
          },
        ],
      });

      await expect(
        approveChannelPairingCode({
          channel: "telegram",
          code: "ABCDEFGH",
          accountId: "yy",
        }),
      ).resolves.toMatchObject({ id: "1001" });
      await expect(readChannelAllowFromStore("telegram", process.env, "yy")).resolves.toEqual([
        "1001",
      ]);
    });
  });

  it("handles pending pairing request lifecycle and limits", async () => {
    await withTempStateDir(async (stateDir) => {
      const first = await upsertChannelPairingRequest({
        channel: "demo-pairing-a",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      const second = await upsertChannelPairingRequest({
        channel: "demo-pairing-a",
        id: "u1",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.code).toBe(first.code);
      const reusedList = await listChannelPairingRequests("demo-pairing-a");
      expect(requireFirstPairingRequest(reusedList).code).toBe(first.code);

      const created = await upsertChannelPairingRequest({
        channel: "demo-pairing-b",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(created.created).toBe(true);
      const filePath = resolvePairingFilePath(stateDir, "demo-pairing-b");
      const raw = fsSync.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        requests?: Array<Record<string, unknown>>;
      };
      const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const requests = (parsed.requests ?? []).map((entry) =>
        Object.assign({}, entry, { createdAt: expiredAt, lastSeenAt: expiredAt }),
      );
      writeJsonFixture(filePath, { version: 1, requests });
      expect(await listChannelPairingRequests("demo-pairing-b")).toHaveLength(0);
      const next = await upsertChannelPairingRequest({
        channel: "demo-pairing-b",
        id: "+15550001111",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(next.created).toBe(true);

      const ids = ["+15550000001", "+15550000002", "+15550000003"];
      for (const id of ids) {
        const capped = await upsertChannelPairingRequest({
          channel: "demo-pairing-c",
          id,
          accountId: DEFAULT_ACCOUNT_ID,
        });
        expect(capped.created).toBe(true);
      }
      const blocked = await upsertChannelPairingRequest({
        channel: "demo-pairing-c",
        id: "+15550000004",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(blocked.created).toBe(false);
      const listIds = (await listChannelPairingRequests("demo-pairing-c")).map((entry) => entry.id);
      expect(listIds).toEqual(["+15550000001", "+15550000002", "+15550000003"]);

      const createdAt = new Date().toISOString();
      writeJsonFixture(resolvePairingFilePath(stateDir, "demo-pairing-d"), {
        version: 1,
        requests: ids.map((id, index) => ({
          id,
          code: `AAAAAAA${String.fromCharCode(66 + index)}`,
          createdAt,
          lastSeenAt: createdAt,
        })),
      });
      const legacyBlocked = await upsertChannelPairingRequest({
        channel: "demo-pairing-d",
        id: "+15550000004",
        accountId: DEFAULT_ACCOUNT_ID,
      });
      expect(legacyBlocked.created).toBe(false);
      const legacyList = await listChannelPairingRequests("demo-pairing-d");
      expect(legacyList.map((entry) => entry.id)).toEqual(ids);
    });
  });

  it("regenerates when a generated code collides", async () => {
    await withTempStateDir(async () => {
      await withMockRandomInt({
        initialValue: 0,
        run: async () => {
          const first = await upsertChannelPairingRequest({
            channel: "telegram",
            id: "123",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(first.code).toBe("AAAAAAAA");

          await withMockRandomInt({
            sequence: Array(8).fill(0).concat(Array(8).fill(1)),
            fallbackValue: 1,
            run: async () => {
              const second = await upsertChannelPairingRequest({
                channel: "telegram",
                id: "456",
                accountId: DEFAULT_ACCOUNT_ID,
              });
              expect(second.code).toBe("BBBBBBBB");
            },
          });
        },
      });
    });
  });

  it("reports unique code exhaustion without exposing reserved codes", async () => {
    await withTempStateDir(async () => {
      await withMockRandomInt({
        initialValue: 0,
        run: async () => {
          const first = await upsertChannelPairingRequest({
            channel: "telegram",
            id: "123",
            accountId: DEFAULT_ACCOUNT_ID,
          });
          expect(first.code).toBe("AAAAAAAA");

          await expect(
            upsertChannelPairingRequest({
              channel: "telegram",
              id: "456",
              accountId: DEFAULT_ACCOUNT_ID,
            }),
          ).rejects.toThrow(
            "failed to generate unique pairing code after 500 attempts; existing code count: 1",
          );
        },
      });
    });
  });

  it("keeps allowFrom account-scoped across manual and pairing-code approvals", async () => {
    await withTempStateDir(async () => {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      await expectAccountScopedEntryIsolated("12345");

      const created = await createTelegramPairingRequest("yy", "67890");
      const approved = await approveChannelPairingCode({
        channel: "telegram",
        code: created.code,
      });
      expect(approved?.id).toBe("67890");
      await expectAccountScopedEntryIsolated("67890");

      const filtered = await createTelegramPairingRequest("yy", "filtered");
      await expect(
        approveChannelPairingCode({
          channel: "telegram",
          code: "   ",
        }),
      ).resolves.toBeNull();
      await expect(
        approveChannelPairingCode({
          channel: "telegram",
          code: filtered.code,
          accountId: "zz",
        }),
      ).resolves.toBeNull();
      const pending = await listChannelPairingRequests("telegram");
      expect(pending.map((entry) => entry.id)).toEqual(["filtered"]);

      const removed = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removed.changed).toBe(true);
      expect(removed.allowFrom).toEqual(["67890"]);

      const removedAgain = await removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "12345",
      });
      expect(removedAgain.changed).toBe(false);
      expect(removedAgain.allowFrom).toEqual(["67890"]);
    });
  });

  it("rethrows unexpected stat errors after allowFrom writes", async () => {
    await withTempStateDir(async (stateDir) => {
      const allowFromPath = resolveAllowFromFilePath(stateDir, "telegram", "yy");
      const error = Object.assign(new Error("stat failed"), { code: "EACCES" });
      const originalStat = fsSync.promises.stat.bind(fsSync.promises);
      const statSpy = vi.spyOn(fsSync.promises, "stat").mockImplementation(async (target) => {
        if (String(target) === allowFromPath) {
          throw error;
        }
        return await originalStat(target);
      });

      try {
        await expect(
          addChannelAllowFromStoreEntry({
            channel: "telegram",
            accountId: "yy",
            entry: "12345",
          }),
        ).rejects.toBe(error);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  it("reads allowFrom variants with account-scoped isolation", async () => {
    await withTempStateDir(async (stateDir) => {
      for (const { setup, accountId, expected, expectedLegacy } of [
        {
          setup: async () => {
            await seedTelegramAllowFromFixtures({
              stateDir,
              scopedAccountId: "yy",
              scopedAllowFrom: [" 1003 ", "*", "1003"],
              legacyAllowFrom: ["1001", "*", "1002", "1001"],
            });
          },
          accountId: "yy",
          expected: ["1003"],
          expectedLegacy: ["1001", "1002"],
        },
        {
          setup: async () => {
            await seedTelegramAllowFromFixtures({
              stateDir,
              scopedAccountId: "yy",
              scopedAllowFrom: [],
            });
          },
          accountId: "yy",
          expected: [],
        },
        {
          setup: async () => {
            await writeAllowFromFixture({
              stateDir,
              channel: "telegram",
              allowFrom: ["1001"],
            });
            const malformedScopedPath = resolveAllowFromFilePath(stateDir, "telegram", "yy");
            fsSync.mkdirSync(path.dirname(malformedScopedPath), { recursive: true });
            fsSync.writeFileSync(malformedScopedPath, "{ this is not json\n", "utf8");
          },
          accountId: "yy",
          expected: [],
        },
        {
          setup: async () => {
            await seedDefaultAccountAllowFromFixture(stateDir);
          },
          accountId: DEFAULT_ACCOUNT_ID,
          expected: ["1002", "1001"],
        },
        {
          setup: async () => {
            await seedDefaultAccountAllowFromFixture(stateDir);
          },
          accountId: undefined,
          expected: ["1002", "1001"],
        },
      ] as const) {
        clearOAuthFixtures(stateDir);
        await setup();
        await expectAllowFromReadConsistencyCase({
          ...(accountId !== undefined ? { accountId } : {}),
          expected,
          ...(expectedLegacy !== undefined ? { expectedLegacy } : {}),
        });
      }
    });
  });

  it("keeps pending pairing requests isolated by account", async () => {
    await withTempStateDir(async (stateDir) => {
      await expectPendingPairingRequestsIsolatedByAccount({
        sharedId: "12345",
        firstAccountId: "alpha",
        secondAccountId: "beta",
      });

      clearOAuthFixtures(stateDir);
      for (const accountId of ["alpha", "beta", "gamma"]) {
        const created = await upsertChannelPairingRequest({
          channel: "telegram",
          accountId,
          id: `pending-${accountId}`,
        });
        expect(created.created).toBe(true);
      }

      const delta = await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "delta",
        id: "pending-delta",
      });
      expect(delta.created).toBe(true);

      const deltaList = await listChannelPairingRequests("telegram", process.env, "delta");
      const allPending = await listChannelPairingRequests("telegram");
      expect(deltaList.map((entry) => entry.id)).toEqual(["pending-delta"]);
      expect(allPending.map((entry) => entry.id)).toEqual([
        "pending-alpha",
        "pending-beta",
        "pending-gamma",
        "pending-delta",
      ]);
    });
  });

  it("reuses cached allowFrom reads and invalidates on file updates", async () => {
    await withTempStateDir(async (stateDir) => {
      for (const variant of [
        {
          createReadSpy: (filePath: string) => {
            const spy = vi.spyOn(fsSync.promises, "readFile");
            return {
              readCount: () => countFileReads(spy, filePath),
              mockRestore: () => spy.mockRestore(),
            };
          },
          readAllowFrom: () => readChannelAllowFromStore("telegram", process.env, "yy"),
        },
        {
          createReadSpy: (filePath: string) => {
            const spy = vi.spyOn(fsSync, "readFileSync");
            return {
              readCount: () => countFileReads(spy, filePath),
              mockRestore: () => spy.mockRestore(),
            };
          },
          readAllowFrom: async () => readChannelAllowFromStoreSync("telegram", process.env, "yy"),
        },
      ]) {
        clearOAuthFixtures(stateDir);
        await expectAllowFromCacheInvalidationWithReadSpy({
          stateDir,
          createReadSpy: variant.createReadSpy,
          readAllowFrom: variant.readAllowFrom,
        });
      }
    });
  });
});
