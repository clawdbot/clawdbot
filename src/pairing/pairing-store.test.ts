// Tests SQLite-backed pairing store lifecycle and account isolation.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelMemoryIdentityAdmission } from "../channels/message-access/memory-identity-admission.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";

const pairingMocks = vi.hoisted(() => ({
  getPairingAdapter: vi.fn<
    () => { idLabel: string; normalizeAllowEntry?: (entry: string) => string } | null
  >(() => null),
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  getPairingAdapter: pairingMocks.getPairingAdapter,
}));

import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  approveChannelPairingRequest,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
  resolveChannelPairingRequestId,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

type PairingTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_pairing_allow_entries" | "channel_pairing_requests"
>;

let fixtureRoot = "";
let caseId = 0;
type RandomIntSync = (minOrMax: number, max?: number) => number;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pairing-"));
});

afterAll(() => {
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  pairingMocks.getPairingAdapter.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function createTestEnv(): { stateDir: string; env: NodeJS.ProcessEnv } {
  const stateDir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function requireFirstPairingRequest(
  requests: Awaited<ReturnType<typeof listChannelPairingRequests>>,
) {
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) {
    throw new Error("expected pairing request");
  }
  return request;
}

function admitVerifiedPairingSender(params: {
  channel?: string;
  accountId?: string;
  senderId: string;
}) {
  const channel = params.channel ?? "telegram";
  return createChannelMemoryIdentityAdmission({
    pluginId: channel,
    adapterId: `plugin:${channel}`,
    ownsChannel: (candidate) => candidate === channel,
    isActive: () => true,
  }).admitVerifiedDirectPairingSender({
    channel,
    accountId: params.accountId ?? "default",
    stableSenderId: params.senderId,
  });
}

function memoryPairingReceiptCount(env: NodeJS.ProcessEnv): number {
  const db = openOpenClawStateDatabase({ env }).db;
  return (
    db.prepare("SELECT COUNT(*) AS count FROM memory_pairing_identity_receipts").get() as {
      count: number;
    }
  ).count;
}

async function withMockRandomInt(params: {
  initialValue?: number;
  sequence?: number[];
  fallbackValue?: number;
  run: () => Promise<void>;
}) {
  const spy = vi.spyOn(crypto, "randomInt") as unknown as {
    mockImplementation: (impl: RandomIntSync) => void;
    mockReturnValue: (value: number) => void;
    mockRestore: () => void;
  };
  try {
    if (params.initialValue !== undefined) {
      spy.mockReturnValue(params.initialValue);
    }
    if (params.sequence) {
      let index = 0;
      spy.mockImplementation(() => params.sequence?.[index++] ?? params.fallbackValue ?? 1);
    }
    await params.run();
  } finally {
    spy.mockRestore();
  }
}

function writeAllowFromFixture(params: {
  env: NodeJS.ProcessEnv;
  channel: string;
  accountId?: string;
  allowFrom: string[];
}) {
  const state = readChannelPairingStateSnapshot(params.channel, params.env);
  state.allowFrom ??= {};
  state.allowFrom[params.accountId ?? DEFAULT_ACCOUNT_ID] = params.allowFrom;
  writeChannelPairingStateSnapshot(params.channel, state, params.env);
}

describe("pairing store", () => {
  it("normalizes allowlist entries through channel pairing adapters", async () => {
    const { env } = createTestEnv();
    pairingMocks.getPairingAdapter.mockReturnValue({
      idLabel: "Telegram user",
      normalizeAllowEntry: (entry) => entry.replace(/^telegram:/i, ""),
    });

    await expect(
      addChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "yy",
        entry: "telegram:1001",
        env,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["1001"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["1001"]);

    const directAdapter = {
      idLabel: "Direct",
      normalizeAllowEntry: (entry: string) => entry.replace(/^direct:/i, ""),
    };
    await expect(
      addChannelAllowFromStoreEntry({
        channel: "external-channel",
        accountId: "main",
        entry: "direct:42",
        env,
        pairingAdapter: directAdapter,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["42"] });
  });

  it("skips malformed persisted requests while approving valid codes", async () => {
    const { env } = createTestEnv();
    const database = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<PairingTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("channel_pairing_requests").values([
        {
          channel_key: "telegram",
          account_id: DEFAULT_ACCOUNT_ID,
          request_id: "",
          code: "BADCODE1",
          created_at: "invalid",
          last_seen_at: "invalid",
          meta_json: null,
        },
        {
          channel_key: "telegram",
          account_id: "alpha",
          request_id: "valid-user",
          code: "GOODCODE",
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          meta_json: JSON.stringify({ accountId: "stale-account" }),
        },
      ]),
    );

    await expect(listChannelPairingRequests("telegram", env, "alpha")).resolves.toHaveLength(1);
    await expect(listChannelPairingRequests("telegram", env, "stale-account")).resolves.toEqual([]);
    await expect(
      approveChannelPairingCode({ channel: "telegram", accountId: "alpha", code: "GOODCODE", env }),
    ).resolves.toMatchObject({ id: "valid-user" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "valid-user",
    ]);
    await expect(readChannelAllowFromStore("telegram", env, "stale-account")).resolves.toEqual([]);
  });

  it("handles pending request reuse, expiry, and per-account limits", async () => {
    const { env } = createTestEnv();
    const first = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "u1",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    const reused = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "u1",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    expect(reused).toEqual({ code: first.code, created: false });

    const expired = await upsertChannelPairingRequest({
      channel: "demo-b",
      id: "expired",
      accountId: DEFAULT_ACCOUNT_ID,
      env,
    });
    expect(expired.created).toBe(true);
    const state = readChannelPairingStateSnapshot("demo-b", env);
    const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    state.requests = state.requests.map((request) => ({
      ...request,
      createdAt: expiredAt,
      lastSeenAt: expiredAt,
    }));
    writeChannelPairingStateSnapshot("demo-b", state, env);
    await expect(listChannelPairingRequests("demo-b", env)).resolves.toEqual([]);

    for (const id of ["one", "two", "three"]) {
      await expect(
        upsertChannelPairingRequest({
          channel: "demo-c",
          id,
          accountId: DEFAULT_ACCOUNT_ID,
          env,
        }),
      ).resolves.toMatchObject({ created: true });
    }
    await expect(
      upsertChannelPairingRequest({
        channel: "demo-c",
        id: "four",
        accountId: DEFAULT_ACCOUNT_ID,
        env,
      }),
    ).resolves.toEqual({ code: "", created: false });
  });

  it("persists a channel-derived approval entry from request metadata", async () => {
    const { env } = createTestEnv();
    const request = await upsertChannelPairingRequest({
      channel: "demo-a",
      id: "alice",
      accountId: DEFAULT_ACCOUNT_ID,
      meta: { proofEntry: "fixture-entry" },
      env,
    });
    const pairingAdapter = {
      idLabel: "peer",
      normalizeAllowEntry: (entry: string) => entry,
      resolveApprovalStoreEntry: ({ meta }: { meta?: Record<string, string> }) =>
        meta?.proofEntry ?? null,
    };

    await expect(
      approveChannelPairingCode({
        channel: "demo-a",
        code: request.code,
        env,
        pairingAdapter,
      }),
    ).resolves.toMatchObject({ id: "alice" });
    await expect(readChannelAllowFromStore("demo-a", env)).resolves.toEqual(["fixture-entry"]);
  });

  it("approves and dismisses account-scoped requests by opaque id", async () => {
    const { env } = createTestEnv();
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "alpha",
      id: "shared-sender",
      env,
    });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      id: "shared-sender",
      env,
    });
    const alphaRequest = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "alpha"),
    );
    const betaRequest = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "beta"),
    );
    const alphaRequestId = resolveChannelPairingRequestId("telegram", alphaRequest);
    const betaRequestId = resolveChannelPairingRequestId("telegram", betaRequest);

    expect(alphaRequestId).not.toBe(betaRequestId);
    expect(alphaRequestId).not.toContain(alphaRequest.code);
    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "alpha",
        requestId: alphaRequestId,
        env,
      }),
    ).resolves.toMatchObject({ id: "shared-sender" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "shared-sender",
    ]);
    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "beta",
        requestId: alphaRequestId,
        env,
      }),
    ).resolves.toBeNull();

    await expect(
      dismissChannelPairingRequest({
        channel: "telegram",
        accountId: "beta",
        requestId: betaRequestId,
        env,
      }),
    ).resolves.toMatchObject({ id: "shared-sender" });
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);
    await expect(listChannelPairingRequests("telegram", env)).resolves.toEqual([]);
  });

  it("regenerates colliding codes and reports exhaustion without leaking codes", async () => {
    const { env } = createTestEnv();
    await withMockRandomInt({
      initialValue: 0,
      run: async () => {
        const first = await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
          accountId: DEFAULT_ACCOUNT_ID,
          env,
        });
        expect(first.code).toBe("AAAAAAAA");

        await withMockRandomInt({
          sequence: Array(8).fill(0).concat(Array(8).fill(1)),
          fallbackValue: 1,
          run: async () => {
            await expect(
              upsertChannelPairingRequest({
                channel: "telegram",
                id: "456",
                accountId: DEFAULT_ACCOUNT_ID,
                env,
              }),
            ).resolves.toMatchObject({ code: "BBBBBBBB" });
          },
        });
      },
    });

    const second = createTestEnv();
    await withMockRandomInt({
      initialValue: 0,
      run: async () => {
        await upsertChannelPairingRequest({
          channel: "telegram",
          id: "123",
          accountId: DEFAULT_ACCOUNT_ID,
          env: second.env,
        });
        await expect(
          upsertChannelPairingRequest({
            channel: "telegram",
            id: "456",
            accountId: DEFAULT_ACCOUNT_ID,
            env: second.env,
          }),
        ).rejects.toThrow(
          "failed to generate unique pairing code after 500 attempts; existing code count: 1",
        );
      },
    });
  });

  it("keeps allowFrom and pending requests isolated by account", async () => {
    const { env } = createTestEnv();
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      accountId: "alpha",
      entry: "1001",
      env,
    });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual(["1001"]);
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);

    const alpha = await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "alpha",
      id: "shared",
      env,
    });
    const beta = await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "beta",
      id: "shared",
      env,
    });
    expect(beta.code).not.toBe(alpha.code);
    expect(
      requireFirstPairingRequest(await listChannelPairingRequests("telegram", env, "alpha")).code,
    ).toBe(alpha.code);
    expect(
      requireFirstPairingRequest(await listChannelPairingRequests("telegram", env, "beta")).code,
    ).toBe(beta.code);

    await expect(
      approveChannelPairingCode({ channel: "telegram", code: alpha.code, env }),
    ).resolves.toMatchObject({ id: "shared" });
    await expect(readChannelAllowFromStore("telegram", env, "alpha")).resolves.toEqual([
      "1001",
      "shared",
    ]);
    await expect(readChannelAllowFromStore("telegram", env, "beta")).resolves.toEqual([]);

    await expect(
      removeChannelAllowFromStoreEntry({
        channel: "telegram",
        accountId: "alpha",
        entry: "1001",
        env,
      }),
    ).resolves.toEqual({ changed: true, allowFrom: ["shared"] });
  });

  it("atomically links a verified receipt to the explicit target profile", async () => {
    const { env } = createTestEnv();
    const admin = ensureProfileForEmail("admin@example.test", { env });
    const alice = ensureProfileForEmail("alice@example.test", { env });
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    }).admitVerifiedDirectPairingSender({
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-alice",
    });
    expect(admission).toBeDefined();
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      id: "pending-alice",
      env,
      memoryIdentityAdmission: admission,
    });
    const request = requireFirstPairingRequest(await listChannelPairingRequests("telegram", env));
    const requestId = resolveChannelPairingRequestId("telegram", request);

    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        requestId,
        env,
        memoryIdentityLink: { targetProfileId: alice.id, createdByProfileId: admin.id },
      }),
    ).resolves.toMatchObject({ id: "pending-alice" });
    expect(await listChannelPairingRequests("telegram", env)).toEqual([]);
    expect(await readChannelAllowFromStore("telegram", env, "default")).toEqual(["pending-alice"]);

    const db = openOpenClawStateDatabase({ env }).db;
    expect(
      db
        .prepare(
          `SELECT p.user_profile_id, b.created_by_profile_id
           FROM memory_identity_bindings b
           JOIN memory_principals p ON p.principal_id = b.principal_id`,
        )
        .get(),
    ).toEqual({ user_profile_id: alice.id, created_by_profile_id: admin.id });
    expect(
      JSON.stringify(db.prepare("SELECT * FROM memory_pairing_identity_receipts").all()),
    ).not.toContain("sender-alice");
  });

  it("keeps a request pending when target linking lacks a verified receipt", async () => {
    const { env } = createTestEnv();
    const admin = ensureProfileForEmail("admin@example.test", { env });
    const alice = ensureProfileForEmail("alice@example.test", { env });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      id: "unverified-alice",
      env,
    });
    const request = requireFirstPairingRequest(await listChannelPairingRequests("telegram", env));

    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        requestId: resolveChannelPairingRequestId("telegram", request),
        env,
        memoryIdentityLink: { targetProfileId: alice.id, createdByProfileId: admin.id },
      }),
    ).rejects.toThrow("memory identity pairing receipt is missing");
    expect(await listChannelPairingRequests("telegram", env)).toHaveLength(1);
    expect(await readChannelAllowFromStore("telegram", env, "default")).toEqual([]);
  });

  it("rejects forged and replayed admissions without creating an unverified request", async () => {
    const { env } = createTestEnv();
    await expect(
      upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        id: "forged",
        env,
        memoryIdentityAdmission: {},
      }),
    ).rejects.toThrow("requires admitted sender evidence");
    expect(await listChannelPairingRequests("telegram", env)).toEqual([]);

    const admission = admitVerifiedPairingSender({ senderId: "one-use" });
    await expect(
      upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        id: "first",
        env,
        memoryIdentityAdmission: admission,
      }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        id: "second",
        env,
        memoryIdentityAdmission: admission,
      }),
    ).rejects.toThrow("requires admitted sender evidence");
    expect(await listChannelPairingRequests("telegram", env)).toHaveLength(1);
  });

  it("uses canonical account scope for verified receipts and target linking", async () => {
    const { env } = createTestEnv();
    const admin = ensureProfileForEmail("admin@example.test", { env });
    const alice = ensureProfileForEmail("alice@example.test", { env });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "Main Account!",
      id: "canonical-account",
      env,
      memoryIdentityAdmission: admitVerifiedPairingSender({
        accountId: "Main Account!",
        senderId: "canonical-account-sender",
      }),
    });
    const request = requireFirstPairingRequest(
      await listChannelPairingRequests("telegram", env, "main-account"),
    );
    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "main-account",
        requestId: resolveChannelPairingRequestId("telegram", request),
        env,
        memoryIdentityLink: { targetProfileId: alice.id, createdByProfileId: admin.id },
      }),
    ).resolves.toMatchObject({ id: "canonical-account" });
    expect(await readChannelAllowFromStore("telegram", env, "Main Account!")).toEqual([
      "canonical-account",
    ]);
  });

  it("removes unconsumed receipts when a request is dismissed or expires", async () => {
    const { env } = createTestEnv();
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      id: "dismissed",
      env,
      memoryIdentityAdmission: admitVerifiedPairingSender({ senderId: "dismissed-sender" }),
    });
    expect(memoryPairingReceiptCount(env)).toBe(1);
    const dismissed = requireFirstPairingRequest(await listChannelPairingRequests("telegram", env));
    await dismissChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      requestId: resolveChannelPairingRequestId("telegram", dismissed),
      env,
    });
    expect(memoryPairingReceiptCount(env)).toBe(0);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      id: "expired",
      env,
      memoryIdentityAdmission: admitVerifiedPairingSender({ senderId: "expired-sender" }),
    });
    expect(memoryPairingReceiptCount(env)).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    await expect(listChannelPairingRequests("telegram", env)).resolves.toEqual([]);
    expect(memoryPairingReceiptCount(env)).toBe(0);
  });

  it("prunes an expired receipt while keeping the targeted request pending", async () => {
    const { env } = createTestEnv();
    const admin = ensureProfileForEmail("admin@example.test", { env });
    const alice = ensureProfileForEmail("alice@example.test", { env });
    await upsertChannelPairingRequest({
      channel: "telegram",
      accountId: "default",
      id: "expired-receipt",
      env,
      memoryIdentityAdmission: admitVerifiedPairingSender({ senderId: "expired-receipt-sender" }),
    });
    const request = requireFirstPairingRequest(await listChannelPairingRequests("telegram", env));
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE memory_pairing_identity_receipts SET expires_at = ?")
      .run(Date.now() - 1);

    await expect(
      approveChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        requestId: resolveChannelPairingRequestId("telegram", request),
        env,
        memoryIdentityLink: { targetProfileId: alice.id, createdByProfileId: admin.id },
      }),
    ).rejects.toThrow("memory identity pairing receipt is missing, expired, or already used");
    expect(await listChannelPairingRequests("telegram", env)).toHaveLength(1);
    expect(await readChannelAllowFromStore("telegram", env, "default")).toEqual([]);
    expect(memoryPairingReceiptCount(env)).toBe(0);
  });

  it("removes the receipt for a persisted request dropped by the per-account cap", async () => {
    const { env } = createTestEnv();
    for (const id of ["old", "second", "third"]) {
      await upsertChannelPairingRequest({
        channel: "telegram",
        accountId: "default",
        id,
        env,
        memoryIdentityAdmission: admitVerifiedPairingSender({ senderId: `${id}-sender` }),
      });
    }
    expect(memoryPairingReceiptCount(env)).toBe(3);
    const state = readChannelPairingStateSnapshot("telegram", env);
    state.requests = [
      ...state.requests.map((request) =>
        request.id === "old" ? { ...request, lastSeenAt: "1970-01-01T00:00:00.000Z" } : request,
      ),
      {
        id: "legacy-extra",
        code: "EXTRA001",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        meta: { accountId: "default" },
      },
    ];
    writeChannelPairingStateSnapshot("telegram", state, env);

    await expect(listChannelPairingRequests("telegram", env)).resolves.toHaveLength(3);
    expect(await listChannelPairingRequests("telegram", env)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "old" })]),
    );
    expect(memoryPairingReceiptCount(env)).toBe(2);
  });

  it("reads current SQLite entries without a process-local file cache", async () => {
    const { env } = createTestEnv();
    writeAllowFromFixture({ env, channel: "telegram", accountId: "yy", allowFrom: ["1001"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["1001"]);
    expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["1001"]);

    writeAllowFromFixture({ env, channel: "telegram", accountId: "yy", allowFrom: ["10022"] });
    await expect(readChannelAllowFromStore("telegram", env, "yy")).resolves.toEqual(["10022"]);
    expect(readChannelAllowFromStoreSync("telegram", env, "yy")).toEqual(["10022"]);
  });
});
