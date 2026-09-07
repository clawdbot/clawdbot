// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

const reportUpdateFailure = vi.hoisted(() =>
  vi.fn<typeof import("./update-failure-report.ts").reportUpdateFailure>(),
);

vi.mock("./update-failure-report.ts", () => ({ reportUpdateFailure }));

const FAILURE = {
  kind: "update",
  status: "error",
  ts: 1_000,
  stats: {
    handoffId: "handoff-failed",
    reason: "build-failed",
    before: { version: "1.0.0" },
    steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
  },
};

const FAILED_RUN = createUpdateRunFixture({
  phase: "finished",
  status: "failed",
  reason: "build-failed",
  finishedAtMs: 1_000,
});

function harnessFor(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    selfUser: { id: "gateway-owner" },
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  reportUpdateFailure.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  { reason: "dirty", reportable: true },
  { reason: "not-git-install", reportable: true },
  { reason: "already-current", reportable: false },
  { reason: "dry-run", reportable: false },
  { reason: "cancelled", reportable: false },
])(
  "offers explicit Report for skipped $reason without changing triage admission",
  async ({ reason, reportable }) => {
    const run = createUpdateRunFixture({ status: "skipped", phase: "finished", reason });
    const request = vi.fn<RequestFn>(async () => ({ lastRun: run }));
    const harness = harnessFor(request);
    const onUpdateFailure = vi.fn();
    reportUpdateFailure.mockResolvedValue(null);
    const overlays = createApplicationOverlays(harness.gateway, { onUpdateFailure });
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(reportable ? run.runId : null);
      expect(reportUpdateFailure).not.toHaveBeenCalled();
      expect(onUpdateFailure).not.toHaveBeenCalled();
      await overlays.reportUpdateFailure(run.runId);
      expect(reportUpdateFailure).toHaveBeenCalledTimes(reportable ? 1 : 0);
      expect(onUpdateFailure).not.toHaveBeenCalled();
    } finally {
      overlays.dispose();
    }
  },
);

describe.each([
  { label: "legacy sentinel", run: null, attemptId: "handoff-failed" },
  { label: "failed run", run: FAILED_RUN, attemptId: FAILED_RUN.runId },
  {
    label: "rolled-back run",
    run: createUpdateRunFixture({ ...FAILED_RUN, status: "rolled-back" }),
    attemptId: FAILED_RUN.runId,
  },
])("update failure report continuity: $label", ({ run, attemptId }) => {
  const requestForStatus = () =>
    vi.fn<RequestFn>(async (method) => {
      if (method === "update.status") {
        return { lastRun: run, sentinel: FAILURE };
      }
      if (method === "update.runs.get") {
        return { run };
      }
      return {};
    });
  it.each(["other-operator", null])(
    "refuses report admission for administrator profile %s",
    async (profileId) => {
      const request = requestForStatus();
      const harness = harnessFor(request);
      harness.update({ selfUser: profileId ? { id: profileId } : null });
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
        await overlays.reportUpdateFailure(attemptId);
        expect(reportUpdateFailure).not.toHaveBeenCalled();
        expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
        expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("never reports during status hydration and suppresses duplicate clicks", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    const pending = deferred<{
      status: "created";
      url: string;
    }>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
      expect(reportUpdateFailure).not.toHaveBeenCalled();

      const first = overlays.reportUpdateFailure(attemptId);
      const duplicate = overlays.reportUpdateFailure(attemptId);
      expect(overlays.snapshot.updateFailureReportBusy).toBe(true);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      pending.resolve({
        status: "created",
        url: "https://github.com/openclaw/openclaw/issues/123",
      });
      await Promise.all([first, duplicate]);

      expect(reportUpdateFailure).toHaveBeenCalledOnce();
      expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
        attemptId,
        result: { status: "created" },
      });
    } finally {
      overlays.dispose();
    }
  });

  it("invalidates an open confirmation on disconnect and restores only the current action", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    const administrator = harness.gateway.snapshot.hello;
    const first = deferred<null>();
    reportUpdateFailure.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const interrupted = overlays.reportUpdateFailure(attemptId);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      const admission = reportUpdateFailure.mock.calls[0]?.[0];
      expect(admission?.isCurrent?.()).toBe(true);

      harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
      expect(admission?.isCurrent?.()).toBe(false);
      first.resolve(null);
      await interrupted;
      expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
      expect(overlays.snapshot.updateFailureReportNotice).toBeNull();

      harness.update({
        phase: "connected",
        client: client(request),
        hello: administrator,
        selfUser: { id: "gateway-owner" },
      });
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
      expect(admission?.isCurrent?.()).toBe(false);
      await overlays.reportUpdateFailure(attemptId);
      expect(reportUpdateFailure).toHaveBeenCalledTimes(2);
    } finally {
      overlays.dispose();
    }
  });

  it("retains the report action and visible error after submission fails", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    reportUpdateFailure.mockRejectedValue(new Error("unknown method: update.report"));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      await overlays.reportUpdateFailure(attemptId);

      expect(overlays.snapshot.updateFailureReportNotice).toMatchObject({
        attemptId,
        result: { status: "error", message: expect.stringContaining("unknown method") },
      });
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
      await overlays.refreshUpdateStatus();
      expect(reportUpdateFailure).toHaveBeenCalledOnce();
      expect(overlays.snapshot.updateFailureReportNotice?.result.status).toBe("error");
    } finally {
      overlays.dispose();
    }
  });

  it("keeps a created URL across an identical reconnect without reporting again", async () => {
    const request = requestForStatus();
    const harness = harnessFor(request);
    const hello = harness.gateway.snapshot.hello;
    reportUpdateFailure.mockResolvedValue({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      await overlays.reportUpdateFailure(attemptId);
      const notice = overlays.snapshot.updateFailureReportNotice;
      harness.update({ phase: "reconnecting", client: null, hello: null, selfUser: null });
      harness.update({
        phase: "connected",
        client: client(request),
        hello,
        selfUser: { id: "gateway-owner" },
      });
      await flushMicrotasks();
      expect(overlays.snapshot.updateFailureReportNotice).toEqual(notice);
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(attemptId);
      expect(reportUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      overlays.dispose();
    }
  });
});

it.each(["changed-facts", "running", "succeeded"] as const)(
  "invalidates report consent when authoritative run becomes %s",
  async (change) => {
    let run = FAILED_RUN;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "update.status") {
        return { lastRun: run, sentinel: FAILURE };
      }
      if (method === "update.runs.get") {
        return { run };
      }
      return {};
    });
    const harness = harnessFor(request);
    const pending = deferred<null>();
    reportUpdateFailure.mockReturnValue(pending.promise);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const reporting = overlays.reportUpdateFailure(run.runId);
      await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
      const admission = reportUpdateFailure.mock.calls[0]?.[0];
      expect(admission?.isCurrent?.()).toBe(true);
      run = createUpdateRunFixture({
        ...run,
        updatedAtMs: run.updatedAtMs + 1,
        ...(change === "changed-facts"
          ? { after: { version: "2026.9.3" } }
          : { status: change, phase: change === "running" ? "staging" : "finished" }),
      });
      harness.emitEvent("update.run.changed", { runId: run.runId, updatedAtMs: run.updatedAtMs });
      expect(admission?.isCurrent?.()).toBe(false);
      await flushMicrotasks();
      expect(overlays.snapshot.reportableUpdateFailureId).toBe(
        change === "changed-facts" ? run.runId : null,
      );
      pending.resolve(null);
      await reporting;
      expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
      expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
      expect(reportUpdateFailure).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(null);
      overlays.dispose();
    }
  },
);

it("retires skipped-failure consent when status refresh advances the same run", async () => {
  let run = createUpdateRunFixture({ status: "skipped", phase: "finished", reason: "dirty" });
  const request = vi.fn<RequestFn>(async () => ({ lastRun: run }));
  const harness = harnessFor(request);
  const pending = deferred<null>();
  reportUpdateFailure.mockReturnValue(pending.promise);
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    await flushMicrotasks();
    const reporting = overlays.reportUpdateFailure(run.runId);
    await vi.waitFor(() => expect(reportUpdateFailure).toHaveBeenCalledOnce());
    const admission = reportUpdateFailure.mock.calls[0]?.[0];
    expect(admission?.isCurrent?.()).toBe(true);
    run = { ...run, updatedAtMs: run.updatedAtMs + 1, reason: "not-git-install" };
    await overlays.refreshUpdateStatus();
    expect(admission?.isCurrent?.()).toBe(false);
    expect(overlays.snapshot.reportableUpdateFailureId).toBe(run.runId);
    pending.resolve(null);
    await reporting;
    expect(overlays.snapshot.updateFailureReportBusy).toBe(false);
    expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
  } finally {
    pending.resolve(null);
    overlays.dispose();
  }
});
