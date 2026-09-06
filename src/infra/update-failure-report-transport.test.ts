import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { submitGithubIssue, type RunGithubCli } from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPending,
  markUpdateFailureReportReceiptPrepared,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
const authSuccess: Awaited<ReturnType<RunGithubCli>> = {
  started: true,
  status: 0,
  stdout: Buffer.alloc(0),
};

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const stateDir = tempDirs.make("openclaw-report-transport-");
  const prepared = await prepareUpdateFailureReport(
    {
      attemptId: "transport-guard",
      result: {
        mode: "npm",
        status: "error",
        reason: "install-failed",
        steps: [],
        durationMs: 1,
        before: { version: "2026.8.1" },
      },
    },
    { stateDir },
  );
  const receipt = () =>
    readUpdateFailureReportReceipt(prepared.attemptId, { OPENCLAW_STATE_DIR: stateDir });
  const createCalls: string[] = [];
  const runGh = vi.fn<RunGithubCli>(async (args, options) => {
    if (args[0] === "auth") {
      return authSuccess;
    }
    if (args[0] !== "api") {
      throw new Error("unexpected GitHub invocation");
    }
    // The observable transport boundary must already have a body-bound durable fence.
    expect(receipt()).toMatchObject({ status: "pending", previewDigest: prepared.previewDigest });
    expect(JSON.parse(options.input)).toEqual({ body: prepared.body, title: prepared.title });
    createCalls.push(options.input);
    return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
  });
  const submit = (options: Parameters<typeof submitUpdateFailureReport>[2] = {}) =>
    submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: (issue, hooks) => submitGithubIssue(issue, runGh, hooks),
      stateDir,
      ...options,
    });
  return { createCalls, prepared, receipt, runGh, stateDir, submit };
}

describe("update report shared transport boundary", () => {
  it("permits saved-only finalization from prepared without widening created or stale ownership", async () => {
    const { prepared, stateDir, receipt } = await setup();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    reserveUpdateFailureReportReceipt(prepared.attemptId, "owner", prepared.previewDigest, env);
    expect(
      markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        "owner",
        prepared.previewDigest,
        env,
      ),
    ).toBe(true);
    const retryable = {
      status: "retryable" as const,
      reservationId: "owner",
      previewDigest: prepared.previewDigest,
    };
    expect(
      finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, status: "created", url: issueUrl },
        env,
      ),
    ).toBe(false);
    expect(
      finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, reservationId: "stale-owner" },
        env,
      ),
    ).toBe(false);
    expect(
      finalizeUpdateFailureReportReceipt(
        prepared.attemptId,
        { ...retryable, previewDigest: "f".repeat(64) },
        env,
      ),
    ).toBe(false);
    expect(receipt()).toMatchObject({ status: "prepared", reservationId: "owner" });
    expect(finalizeUpdateFailureReportReceipt(prepared.attemptId, retryable, env)).toBe(true);
    expect(receipt()).toMatchObject(retryable);
  });

  it("binds saved-only Unicode reports to the exact shared body and distinct update attempts", async () => {
    const stateDir = tempDirs.make("openclaw-report-long-body-");
    const input = {
      attemptId: "long-report-A",
      result: {
        mode: "npm" as const,
        status: "error" as const,
        reason: "🦞".repeat(150),
        steps: Array.from({ length: 3 }, (_, i) => ({
          name: `${i}${"🦞".repeat(150)}`,
          command: "private command must not appear",
          cwd: "/Users/private/report",
          durationMs: 1,
          exitCode: 1,
        })),
        durationMs: 1,
      },
      target: "🦞".repeat(150),
    };
    const prepared = await prepareUpdateFailureReport(input, { stateDir });
    const otherAttempt = await prepareUpdateFailureReport(
      { ...input, attemptId: "long-report-B" },
      { stateDir },
    );
    expect(otherAttempt.marker).not.toBe(prepared.marker);
    expect(prepared.browserFallback.status).toBe("unavailable");
    expect(prepared.url).toBeUndefined();
    expect(prepared.previewDigest).toBe(createHash("sha256").update(prepared.body).digest("hex"));
    expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(16_000);
    expect(prepared.body).not.toContain("�");
    expect(prepared.body).not.toContain("private");
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValue({ started: true, status: 1, stdout: Buffer.alloc(0) });
    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: (issue, hooks) => submitGithubIssue(issue, runGh, hooks),
      stateDir,
    });
    expect(result).toMatchObject({ status: "retryable" });
    expect(result).not.toHaveProperty("fallbackUrl");
    expect(runGh).toHaveBeenCalledOnce();
    expect(await fs.readFile(result.savedReportPath, "utf8")).toBe(prepared.body);
  });

  it("commits pending before POST and reuses the created receipt without transport", async () => {
    const fixture = await setup();
    expect(await fixture.submit()).toMatchObject({ status: "created", url: issueUrl });
    expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.runGh).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "does not start POST with retired authority after pending, retire=%s",
    async (retire) => {
      const fixture = await setup();
      let current = true;
      const authorityAtPost: boolean[] = [];
      const result = await fixture
        .submit({
          hasCurrentAuthority: () => current,
          markPending: (...args) => {
            const marked = markUpdateFailureReportReceiptPending(...args);
            expect(marked).toBe(true);
            if (retire) {
              queueMicrotask(() => {
                current = false;
              });
            }
            return marked;
          },
          createIssue: (issue, hooks) =>
            submitGithubIssue(
              issue,
              (args, options) => {
                if (args[0] === "api") {
                  authorityAtPost.push(current);
                }
                return fixture.runGh(args, options);
              },
              hooks,
            ),
        })
        .catch((error: unknown) => error);
      expect.soft(authorityAtPost).not.toContain(false);
      if (authorityAtPost.length === 0) {
        expect(retire).toBe(true);
        expect(result).toBeInstanceOf(Error);
        expect(fixture.receipt()).toBeNull();
        await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(authorityAtPost).toHaveLength(1);
        expect(result).toMatchObject({ status: "created", url: issueUrl });
        expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
        expect(fixture.createCalls).toHaveLength(1);
      }
    },
  );

  it.each([false, true])(
    "rejects retired authority after async preparation returns, retire=%s",
    async (retire) => {
      const fixture = await setup();
      let current = true;
      const result = await fixture
        .submit({
          hasCurrentAuthority: () => current,
          createIssue: (issue, hooks) =>
            submitGithubIssue(issue, fixture.runGh, {
              ...hooks,
              beforeIssueCreate: async () => {
                if (!hooks.beforeIssueCreate) {
                  throw new Error("expected a guarded Report submission");
                }
                const commit = await hooks.beforeIssueCreate();
                if (retire) {
                  queueMicrotask(() => {
                    current = false;
                  });
                }
                return commit;
              },
            }),
        })
        .catch((error: unknown) => error);
      if (retire) {
        expect.soft(result).toBeInstanceOf(Error);
        expect.soft(fixture.createCalls).toHaveLength(0);
        expect.soft(fixture.receipt()).toBeNull();
        await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(result).toMatchObject({ status: "created", url: issueUrl });
        expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
        expect(fixture.createCalls).toHaveLength(1);
      }
    },
  );

  it.each(["authority", "attempt"] as const)(
    "refuses %s lost while authentication is paused before pending or POST",
    async (change) => {
      const fixture = await setup();
      const entered = createDeferredCore();
      const released = createDeferredCore();
      fixture.runGh.mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
        return authSuccess;
      });
      let current = true;
      const submission = fixture.submit({
        hasCurrentAuthority: () => change !== "authority" || current,
        validateCurrentAttempt: () => change !== "attempt" || current,
      });
      // Observe rejection immediately, before releasing the asynchronous guard.
      const observed = submission.then(
        (value) => value,
        (error: unknown) => error,
      );
      await entered.promise;
      current = false;
      released.resolve();
      const result = await observed;
      if (change === "authority") {
        expect(result).toBeInstanceOf(Error);
      } else {
        expect(result).toMatchObject({ status: "stale" });
      }
      expect(fixture.runGh).toHaveBeenCalledOnce();
      expect(fixture.createCalls).toHaveLength(0);
      expect(fixture.receipt()).toBeNull();
      await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    { label: "retired", retire: true },
    { label: "live", retire: false },
  ])(
    "checks $label authority at the pending commit after attempt validation",
    async ({ retire }) => {
      const fixture = await setup();
      let current = true;
      let insidePreCreate = false;
      let retireAfterValidation = false;
      let receiptAtRetirement: string | undefined;
      const result = await fixture
        .submit({
          createIssue: (issue, hooks) =>
            submitGithubIssue(issue, fixture.runGh, {
              ...hooks,
              beforeIssueCreate: () => {
                insidePreCreate = true;
                if (!hooks.beforeIssueCreate) {
                  throw new Error("expected a guarded Report submission");
                }
                return hooks.beforeIssueCreate();
              },
            }),
          validateCurrentAttempt: () => {
            retireAfterValidation = insidePreCreate && retire;
            return true;
          },
          hasCurrentAuthority: () => {
            if (retireAfterValidation) {
              retireAfterValidation = false;
              queueMicrotask(() => {
                receiptAtRetirement = fixture.receipt()?.status;
                current = false;
              });
            }
            return current;
          },
        })
        .catch((error: unknown) => error);
      if (retire) {
        expect(receiptAtRetirement).toBe("prepared");
        expect({
          rejected: result instanceof Error,
          invocations: fixture.runGh.mock.calls.map(([args]) => args[0]),
          creates: fixture.createCalls.length,
          receipt: fixture.receipt(),
        }).toEqual({ rejected: true, invocations: ["auth"], creates: 0, receipt: null });
        await expect(fs.stat(`${fixture.stateDir}/update-reports`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(result).toMatchObject({ status: "created", url: issueUrl });
        expect(await fixture.submit()).toMatchObject({ status: "duplicate", url: issueUrl });
        expect(fixture.createCalls).toHaveLength(1);
        expect(fixture.runGh).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([
    { label: "missing", errorCode: "ENOENT", started: false, status: null },
    { label: "unauthenticated", started: true, status: 1 },
    { label: "preflight timeout", errorCode: "ETIMEDOUT", started: true, status: null },
  ])("offers the exact browser body after $label auth without POST", async (failure) => {
    const fixture = await setup();
    fixture.runGh.mockResolvedValueOnce({ ...failure, stdout: Buffer.alloc(0) });
    const result = await fixture.submit();
    expect(result).toMatchObject({ status: "fallback", fallbackUrl: fixture.prepared.url });
    expect(fixture.runGh).toHaveBeenCalledOnce();
    expect(fixture.createCalls).toHaveLength(0);
    expect(new URL(fixture.prepared.url!).searchParams.get("body")).toBe(fixture.prepared.body);
  });

  it("keeps post-create ambiguity pending when revoked authority prevents reconciliation", async () => {
    const fixture = await setup();
    let current = true;
    fixture.runGh.mockImplementation(async (args) => {
      if (args[0] === "auth") {
        return authSuccess;
      }
      expect(args[0]).toBe("api");
      current = false;
      return { errorCode: "ETIMEDOUT", started: true, status: null, stdout: Buffer.alloc(0) };
    });
    const result = await fixture.submit({ hasCurrentAuthority: () => current });
    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("fallbackUrl");
    expect(fixture.receipt()).toMatchObject({ status: "pending" });
    expect(fixture.runGh).toHaveBeenCalledTimes(2);
    expect((await fs.stat(result.savedReportPath)).mode & 0o777).toBe(0o600);
  });

  it("lets a successor CAS independently while an expired owner is still authenticating", async () => {
    const fixture = await setup();
    let nowMs = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const entered = createDeferredCore();
    const released = createDeferredCore();
    fixture.runGh.mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
      return authSuccess;
    });
    const oldSubmission = fixture.submit();
    await entered.promise;
    nowMs += 10 * 60_000;
    const successor = await fixture.submit();
    expect(successor).toMatchObject({ status: "created", url: issueUrl });
    released.resolve();
    expect(await oldSubmission).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.runGh).toHaveBeenCalledTimes(3);
  });
});
