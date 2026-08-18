import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const roots: string[] = [];

function createStateDir(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecars-")));
  roots.push(root);
  return root;
}

function countStoredRows(name: string): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
    .get(name) as { count: number };
  return row.count;
}

function writeStoredSecret(name: string, value: string): void {
  writeSecretStoreEntry({
    scope: { kind: "team" },
    name,
    value,
    kind: "secret",
    allowedHosts: [],
    updatedBy: "test",
  });
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("gateway lifetime sidecars", () => {
  test("keeps pre-published sidecars reachable by shutdown", async () => {
    const metadataListener = { stop: vi.fn(async () => {}) };
    const sessionChange = { stop: vi.fn(async () => {}) };
    const worker = { stop: vi.fn(async () => {}) };

    let sidecars: GatewayPostReadySidecarHandle[] = [metadataListener, sessionChange];
    const owner = createGatewaySidecarStopOwner({
      getRegistered: () => sidecars,
      setRegistered: (next) => {
        sidecars = next;
      },
    });
    owner.publish([worker, metadataListener]);
    expect(sidecars).toEqual([metadataListener, sessionChange, worker]);

    await owner.stop();
    expect(metadataListener.stop).toHaveBeenCalledOnce();
    expect(sessionChange.stop).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  test.each([
    { minimalTestGateway: false, expectedHandoffRows: 0 },
    { minimalTestGateway: true, expectedHandoffRows: 1 },
  ])(
    "owns startup and scheduled handoff expiry when minimalTestGateway=$minimalTestGateway",
    async ({ minimalTestGateway, expectedHandoffRows }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const startupHandoff = "github-setup-55555555555555555555555555555555";
        writeStoredSecret(startupHandoff, "temporary-value");
        writeStoredSecret("RETAINED_SECRET", "retained-value");
        vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
        const sidecars: GatewayPostReadySidecarHandle[] = [];
        const owner = createGatewaySidecarStopOwner({
          getRegistered: () => sidecars,
          setRegistered: (next) => sidecars.splice(0, sidecars.length, ...next),
        });

        await attachInitialGatewayLifetimeSidecars({
          chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
          gatewayRequestContext: {} as never,
          flushPendingSessionsChangedEvents: vi.fn(),
          minimalTestGateway,
          logWarning: vi.fn(),
          sidecars,
        });
        expect(countStoredRows(startupHandoff)).toBe(expectedHandoffRows);

        const scheduledHandoff = "github-setup-77777777777777777777777777777777";
        writeStoredSecret(scheduledHandoff, "scheduled-value");
        await vi.advanceTimersByTimeAsync(11 * 60_000);

        expect(countStoredRows(scheduledHandoff)).toBe(expectedHandoffRows);
        expect(countStoredRows("RETAINED_SECRET")).toBe(1);
        await owner.stop();

        const stoppedHandoff = "github-setup-66666666666666666666666666666666";
        writeStoredSecret(stoppedHandoff, "post-stop-value");
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(countStoredRows(stoppedHandoff)).toBe(1);
      });
    },
  );
});
