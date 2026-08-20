// Focused coverage for timer-driven approval expiry publication; the main
// exec-approval-manager suite sits at the max-lines cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";

type TimeoutCallback = Parameters<typeof setTimeout>[0];
type MockTimerHandle = ReturnType<typeof setTimeout> & {
  unref: ReturnType<typeof vi.fn>;
};

describe("ExecApprovalManager timeout expiry publication", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabase();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function installTimerMocks() {
    const timers: Array<{
      callback: TimeoutCallback;
      delay: number | undefined;
      handle: MockTimerHandle;
    }> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimeoutCallback,
      delay?: number,
    ) => {
      const handle = { unref: vi.fn() } as unknown as MockTimerHandle;
      timers.push({ callback, delay, handle });
      return handle;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout,
    );
    return timers;
  }

  it("publishes timer-driven timeout expiry through onExpired", async () => {
    const timers = installTimerMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const expirations: Array<{ recordId: string; status: string; requestCommand?: string }> = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-expired-"));
    tempDirs.push(dir);
    const manager = new ExecApprovalManager<ExecApprovalRequestPayload>({
      approvalKind: "exec",
      persistence: {
        runtimeEpoch: "runtime-a",
        databaseOptions: { path: path.join(dir, "s.sqlite") },
      },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      onExpired: (record, liveRecord) =>
        expirations.push({
          recordId: record.id,
          status: record.status,
          requestCommand: liveRecord.request.command,
        }),
    });
    const record = manager.create({ command: "echo expired" }, 60_000, "approval-on-expired");
    const decisionPromise = manager.register(record, 60_000);
    vi.mocked(Date.now).mockReturnValue(record.expiresAtMs);

    const timer = timers[0];
    if (!timer || typeof timer.callback !== "function") {
      throw new Error("expected timer callback");
    }
    timer.callback();

    await expect(decisionPromise).resolves.toBeNull();
    // The gateway clock owns expiry: reviewer surfaces get the terminal fact
    // (with the live request for the event payload) instead of inferring it.
    expect(expirations).toEqual([
      { recordId: record.id, status: "expired", requestCommand: "echo expired" },
    ]);
  });

  it("rejects ask-fallback replay of a run-aborted cancellation", async () => {
    installTimerMocks();
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "approval-cancelled");
    const decisionPromise = manager.register(record, 60_000);

    // Dispatch fencing / run abort ends decision-less like a timeout, but its
    // authority closed deliberately — replay must not re-admit through it.
    const denied = manager.forceDenyDetailed(
      "approval-cancelled",
      "run-aborted",
      { kind: "system", id: "worker-dispatch" },
      "cancelled",
    );
    expect(denied.outcome).toBe("denied");
    await expect(decisionPromise).resolves.toBeNull();

    expect(manager.getSnapshot("approval-cancelled")).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    expect(manager.consumeAskFallback("approval-cancelled")).toBe(false);
  });
});
