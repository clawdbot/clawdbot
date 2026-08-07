import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  hasFreshGatewayStartupProgress,
  withGatewayStartupProgress,
} from "./gateway-startup-progress.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type GatewayStartupLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

const { getFileLockProcessStartTime, isPidAlive } = vi.hoisted(() => ({
  getFileLockProcessStartTime: vi.fn<(pid: number) => number | null>(() => 123),
  isPidAlive: vi.fn<(pid: number) => boolean>(() => true),
}));

vi.mock("../shared/pid-alive.js", () => ({ getFileLockProcessStartTime, isPidAlive }));

beforeEach(() => {
  getFileLockProcessStartTime.mockReset().mockReturnValue(123);
  isPidAlive.mockReset().mockReturnValue(true);
});

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("gateway startup progress", () => {
  it("releases the startup lease when startup fails", async () => {
    await withOpenClawTestState({ label: "gateway-startup-progress-release" }, async (state) => {
      const failure = new Error("startup failed");
      const readLease = () => {
        const database = openOpenClawStateDatabase({ env: state.env }).db;
        return executeSqliteQueryTakeFirstSync(
          database,
          getNodeSqliteKysely<GatewayStartupLeaseDatabase>(database)
            .selectFrom("state_leases")
            .select(["lease_key", "payload_json"])
            .where("scope", "=", "gateway.startup"),
        );
      };

      await expect(
        withGatewayStartupProgress(
          async () => {
            expect(readLease()).toMatchObject({
              lease_key: "current",
              payload_json: expect.stringContaining(`"pid":${process.pid}`),
            });
            throw failure;
          },
          { env: state.env },
        ),
      ).rejects.toBe(failure);

      expect(readLease()).toBeUndefined();
    });
  });

  it.each([
    { label: "valid renewed progress", overrides: {}, expected: true },
    { label: "one-shot unrenewed row", overrides: { heartbeat_at: 9_900 }, expected: false },
    { label: "pre-request row", overrides: { created_at: 9_700 }, expected: false },
    { label: "stale heartbeat", overrides: { heartbeat_at: -5_001 }, expected: false },
    { label: "expired row", overrides: { expires_at: 9_999 }, expected: false },
    {
      label: "different pid",
      overrides: { payload_json: JSON.stringify({ pid: process.pid + 1, starttime: 123 }) },
      expected: false,
    },
    {
      label: "different process identity",
      overrides: { payload_json: JSON.stringify({ pid: process.pid, starttime: 124 }) },
      expected: false,
    },
    { label: "dead expected process", overrides: {}, currentAlive: false, expected: false },
    { label: "reused expected pid", overrides: {}, currentStartTime: 124, expected: false },
    { label: "malformed payload", overrides: { payload_json: "{" }, expected: false },
  ])("classifies $label", async (testCase) => {
    const { overrides, expected } = testCase;
    const currentAlive = "currentAlive" in testCase ? testCase.currentAlive : undefined;
    const currentStartTime = "currentStartTime" in testCase ? testCase.currentStartTime : undefined;
    await withOpenClawTestState({ label: "gateway-startup-progress-read" }, async (state) => {
      const nowMs = 10_000;
      const processStartTime = 123;
      const payload_json = JSON.stringify({ pid: process.pid, starttime: processStartTime });
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<GatewayStartupLeaseDatabase>(db)
              .insertInto("state_leases")
              .values({
                scope: "gateway.startup",
                lease_key: "current",
                owner: "test-owner",
                expires_at: 20_000,
                heartbeat_at: 9_950,
                payload_json,
                created_at: 9_900,
                updated_at: 9_950,
                ...overrides,
              }),
          );
        },
        { env: state.env },
      );

      isPidAlive.mockReturnValue(currentAlive ?? true);
      getFileLockProcessStartTime.mockReturnValue(currentStartTime ?? processStartTime);

      expect(
        hasFreshGatewayStartupProgress(
          { pid: process.pid, processStartTime, requestedAtMs: 9_800 },
          { env: state.env, nowMs },
        ),
      ).toBe(expected);
    });
  });
});
