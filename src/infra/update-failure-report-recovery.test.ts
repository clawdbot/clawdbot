import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  GithubIssueSubmitHooks,
  GithubIssueReconcileHooks,
  PreparedGithubIssue,
} from "./github-issue.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  beginUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPrepared,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import { mockCreatedIssue, mockFallbackIssue } from "./update-failure-report.test-support.js";
import type { UpdateRunResult } from "./update-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PreparedReport = Awaited<ReturnType<typeof prepareUpdateFailureReport>>;

function savedReportArtifactPath(
  prepared: PreparedReport,
  reservationId: string,
  previewDigest = prepared.previewDigest,
): string {
  const parsed = path.parse(prepared.savedReportPath);
  const artifactKey = createHash("sha256")
    .update(`${reservationId}\0${previewDigest}`)
    .digest("hex");
  return path.join(parsed.dir, `${parsed.name}.${artifactKey}${parsed.ext}`);
}

function failedUpdate(): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [{ name: "build", command: "pnpm build", cwd: "/repo", durationMs: 12, exitCode: 1 }],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
  };
}

function mockRetryableNoStartIssue() {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      cause: "transport-unavailable" as const,
      reason: "fallback-url-too-long" as const,
      status: "fallback-unavailable" as const,
    };
  });
}

function stateEnv(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir };
}

describe("update failure report receipt recovery", () => {
  it.each(["created", "fallback"] as const)(
    "recovers a committed %s receipt after its writer loses the acknowledgement",
    async (status) => {
      const stateDir = tempDirs.make("openclaw-update-report-");
      const prepared = await prepareUpdateFailureReport(
        { attemptId: `attempt-${status}-lost-ack`, result: failedUpdate() },
        { stateDir },
      );
      const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
      const createIssue =
        status === "created" ? mockCreatedIssue(issueUrl) : mockFallbackIssue(prepared.url);
      const finalizeReceipt = vi.fn(
        (...args: Parameters<typeof finalizeUpdateFailureReportReceipt>) => {
          const committed = finalizeUpdateFailureReportReceipt(...args);
          if (committed) {
            throw new Error("simulated lost commit acknowledgement");
          }
          return committed;
        },
      );

      const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        finalizeReceipt,
        stateDir,
      });
      const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
      });

      expect(first).toMatchObject(
        status === "created" ? { status, url: issueUrl } : { fallbackUrl: prepared.url, status },
      );
      expect(second).toMatchObject(
        status === "created"
          ? { status: "duplicate", url: issueUrl }
          : { fallbackUrl: prepared.url, status: "duplicate" },
      );
      expect(createIssue).toHaveBeenCalledOnce();
      await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("keeps a post-create persistence outage pending without replaying transport", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-persistence-outage", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({
      message: expect.stringContaining("canonical receipt is still pending"),
      status: "created",
      url: issueUrl,
    });
    expect(second).toMatchObject({ status: "pending" });
    expect(second).not.toHaveProperty("url");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("persists a proven no-start result after transient receipt contention", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-no-start-transient-receipt", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockRetryableNoStartIssue();
    const finalizeReceipt = vi
      .fn(finalizeUpdateFailureReportReceipt)
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error("simulated transient SQLite contention");
      })
      .mockReturnValueOnce(false);

    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });

    expect(result).toMatchObject({ status: "retryable" });
    expect(finalizeReceipt).toHaveBeenCalledTimes(4);
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "retryable",
    });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("cleans a retryable reservation artifact before replacing its owner", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-retryable-owner-replacement", result: failedUpdate() },
      { stateDir },
    );
    const firstCreateIssue = mockRetryableNoStartIssue();

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: firstCreateIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "retryable" });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const secondCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: secondCreateIssue,
      stateDir,
    });

    expect(second).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(second.savedReportPath).not.toBe(first.savedReportPath);
    expect(firstCreateIssue).toHaveBeenCalledOnce();
    expect(secondCreateIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains retryable ownership until interrupted artifact cleanup completes", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-retryable-cleanup-interruption", result: failedUpdate() },
      { stateDir },
    );
    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockRetryableNoStartIssue(),
      stateDir,
    });
    const secondCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
    const rm = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(new Error("simulated retryable cleanup interruption"));

    let second: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: secondCreateIssue,
        stateDir,
      });
    } finally {
      rm.mockRestore();
    }

    expect(second).toMatchObject({ status: "retryable" });
    expect(secondCreateIssue).not.toHaveBeenCalled();
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      cleanup: "pending",
      reservationId: expect.any(String),
      status: "retryable",
    });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const third = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: secondCreateIssue,
      stateDir,
    });

    expect(third).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(secondCreateIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a retryable artifact when a later submission is stale", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-retryable-stale", result: failedUpdate() },
      { stateDir },
    );
    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockRetryableNoStartIssue(),
      stateDir,
    });
    const staleCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const stale = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: staleCreateIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(stale).toMatchObject({ status: "stale" });
    expect(staleCreateIssue).not.toHaveBeenCalled();
    const receipt = readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir));
    expect(receipt).toMatchObject({ status: "retryable" });
    expect(receipt).not.toHaveProperty("cleanup");
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);
  });

  it("cleans an expired preparation artifact before replacing its owner", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-preparation-artifact", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const expiredReservationId = "expired-preparation-owner";
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        stateEnv(stateDir),
      ),
    ).toMatchObject({ reserved: true });
    const expiredReportPath = savedReportArtifactPath(prepared, expiredReservationId);
    await fs.mkdir(path.dirname(expiredReportPath), { recursive: true });
    await fs.writeFile(expiredReportPath, prepared.body, { mode: 0o600 });
    nowMs += 10 * 60_000;

    let result: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
        stateDir,
      });
    } finally {
      now.mockRestore();
    }

    expect(result).toMatchObject({ status: "created" });
    expect(result.savedReportPath).not.toBe(expiredReportPath);
    await expect(fs.stat(expiredReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains expired preparation custody when cleanup is interrupted", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-preparation-cleanup", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const expiredReservationId = "expired-cleanup-owner";
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        stateEnv(stateDir),
      ),
    ).toMatchObject({ reserved: true });
    const expiredReportPath = savedReportArtifactPath(prepared, expiredReservationId);
    await fs.mkdir(path.dirname(expiredReportPath), { recursive: true });
    await fs.writeFile(expiredReportPath, prepared.body, { mode: 0o600 });
    nowMs += 10 * 60_000;
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");
    const rm = vi
      .spyOn(fs, "rm")
      .mockRejectedValueOnce(new Error("simulated expired cleanup interruption"));

    let interrupted: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      interrupted = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
      });
    } finally {
      rm.mockRestore();
    }

    expect(interrupted).toMatchObject({ status: "retryable" });
    expect(createIssue).not.toHaveBeenCalled();
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      cleanup: "pending",
      reservationId: expiredReservationId,
      status: "retryable",
    });
    await expect(fs.readFile(expiredReportPath, "utf8")).resolves.toBe(prepared.body);

    const recovered = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    now.mockRestore();

    expect(recovered).toMatchObject({ status: "created" });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(expiredReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves non-growing expired-owner sweep custody across repeated retries", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-owner-successor-retry", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const expiredReservationId = "expired-owner-before-retry";
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        stateEnv(stateDir),
      ),
    ).toMatchObject({ reserved: true });
    nowMs += 10 * 60_000;

    let retryable: Awaited<ReturnType<typeof submitUpdateFailureReport>> | undefined;
    for (let index = 0; index < 20; index += 1) {
      retryable = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: mockRetryableNoStartIssue(),
        stateDir,
      });
      expect(retryable).toMatchObject({ status: "retryable" });
    }

    const created = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    now.mockRestore();

    expect(created).toMatchObject({ status: "created" });
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      artifactSweep: "pending",
      status: "created",
    });
    if (!retryable) {
      throw new Error("expected the repeated retry result");
    }
    await expect(fs.stat(retryable.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a created issue after restart before stale-attempt validation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-reconcile-restart", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);

    const submitted = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
    });
    const reconcileIssue = vi.fn(async () => ({ status: "created" as const, url: issueUrl }));
    const recovered = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      reconcileIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(recovered).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(reconcileIssue).toHaveBeenCalledWith(prepared, expect.any(Object));
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expect(fs.stat(submitted.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an unreconciled restart pending without replaying issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-reconcile-miss", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
    });
    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      reconcileIssue: async () => ({ status: "not-found" }),
      stateDir,
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("stops restart reconciliation when client authority expires before lookup", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-reconcile-revoked", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      stateDir,
    });
    let authorityCurrent = true;
    let lookupCalls = 0;
    const reconcileIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) => {
        authorityCurrent = false;
        await hooks.beforeIssueLookup?.();
        lookupCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      hasCurrentAuthority: () => authorityCurrent,
      reconcileIssue,
      stateDir,
    });

    expect(result).toMatchObject({ status: "pending" });
    expect(result).not.toHaveProperty("url");
    expect(lookupCalls).toBe(0);
    expect(createIssue).toHaveBeenCalledOnce();
    expect(readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir))).toMatchObject({
      status: "pending",
    });
  });

  it("returns the created URL when post-transport receipt reads are also unavailable", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-read-outage", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const readReceipt = vi
      .fn(readUpdateFailureReportReceipt)
      .mockImplementationOnce(readUpdateFailureReportReceipt)
      .mockImplementationOnce(() => {
        throw new Error("simulated state read outage after transport");
      });

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt: () => false,
      readReceipt,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("commits cleanup intent before filesystem deletion and resumes it after reconnect", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-cleanup-reconnect", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    let observedReceipt: ReturnType<typeof readUpdateFailureReportReceipt> | undefined;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        path.dirname(String(target)) === path.dirname(prepared.savedReportPath) &&
        path.basename(String(target)).startsWith(`${path.parse(prepared.savedReportPath).name}.`)
      ) {
        observedReceipt = readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir));
        throw new Error("simulated post-commit cleanup interruption");
      }
      return await realRm(target, options);
    });

    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
      });
    } finally {
      rm.mockRestore();
    }

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(observedReceipt).toMatchObject({
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      status: "created",
      url: issueUrl,
    });
    await expect(fs.readFile(first.savedReportPath, "utf8")).resolves.toBe(prepared.body);

    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const completed = readUpdateFailureReportReceipt(prepared.attemptId, stateEnv(stateDir));
    expect(completed).toMatchObject({
      status: "created",
      url: issueUrl,
    });
    expect(completed).not.toHaveProperty("cleanup");
  });

  it("records abandoned cleanup before deleting and can resume after interruption", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-abandoned-cleanup", result: failedUpdate() },
      { stateDir },
    );
    const reservationId = "cleanup-owner";
    const env = stateEnv(stateDir);
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        reservationId,
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const savedReportPath = savedReportArtifactPath(prepared, reservationId);
    await fs.mkdir(path.dirname(savedReportPath), { recursive: true });
    await fs.writeFile(savedReportPath, prepared.body, { mode: 0o600 });

    expect(beginUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env)).toBe(
      true,
    );
    expect(readUpdateFailureReportReceipt(prepared.attemptId, env)).toMatchObject({
      cleanup: "pending",
      status: "retryable",
    });
    await expect(fs.readFile(savedReportPath, "utf8")).resolves.toBe(prepared.body);

    await fs.rm(savedReportPath);
    expect(completeUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, env)).toBe(
      true,
    );
    expect(readUpdateFailureReportReceipt(prepared.attemptId, env)).toBeNull();
  });

  it("refuses to start transport after the approved preview digest changes", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-pending-digest-change", result: failedUpdate() },
      { stateDir },
    );
    const env = stateEnv(stateDir);
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "digest-owner",
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    expect(
      markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        "digest-owner",
        prepared.previewDigest,
        env,
      ),
    ).toBe(true);

    expect(
      markUpdateFailureReportReceiptPending(
        prepared.attemptId,
        "digest-owner",
        "f".repeat(64),
        env,
      ),
    ).toBe(false);
    expect(readUpdateFailureReportReceipt(prepared.attemptId, env)).toMatchObject({
      previewDigest: prepared.previewDigest,
      status: "prepared",
    });
  });

  it.each([
    { cleanup: "pending" as const, reservationId: "owner", status: "created" as const },
    {
      fallbackUrl: "https://evil.example/openclaw/openclaw/issues/new",
      reservationId: "owner",
      status: "fallback" as const,
    },
  ])(
    "refuses an unreadable terminal receipt without wedging the pending owner",
    async (receipt) => {
      const stateDir = tempDirs.make("openclaw-update-report-");
      const prepared = await prepareUpdateFailureReport(
        { attemptId: `attempt-invalid-terminal-${receipt.status}`, result: failedUpdate() },
        { stateDir },
      );
      const env = stateEnv(stateDir);
      expect(
        reserveUpdateFailureReportReceipt(
          prepared.attemptId,
          receipt.reservationId,
          prepared.previewDigest,
          env,
        ),
      ).toMatchObject({ reserved: true });
      expect(
        markUpdateFailureReportReceiptPrepared(
          prepared.attemptId,
          receipt.reservationId,
          prepared.previewDigest,
          env,
        ),
      ).toBe(true);
      if (receipt.status === "created") {
        expect(
          markUpdateFailureReportReceiptPending(
            prepared.attemptId,
            receipt.reservationId,
            prepared.previewDigest,
            env,
          ),
        ).toBe(true);
      }

      expect(
        finalizeUpdateFailureReportReceipt(
          prepared.attemptId,
          { ...receipt, previewDigest: prepared.previewDigest },
          env,
        ),
      ).toBe(false);
      expect(readUpdateFailureReportReceipt(prepared.attemptId, env)).toMatchObject({
        previewDigest: prepared.previewDigest,
        status: receipt.status === "created" ? "pending" : "prepared",
      });
    },
  );

  it("parses a pre-upgrade receipt conservatively without exposing an unbound URL", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-legacy-receipt", result: failedUpdate() },
      { stateDir },
    );
    const env = stateEnv(stateDir);
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "legacy-owner",
        prepared.previewDigest,
        env,
      ),
    ).toMatchObject({ reserved: true });
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb =
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">>(db);
    const key = `update-failure-report:${createHash("sha256")
      .update(prepared.attemptId)
      .digest("hex")}`;
    const legacyReceipt = {
      reservationId: "legacy-owner",
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    };
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("gateway_restart_sentinel")
        .set({
          message: JSON.stringify(legacyReceipt),
          payload_json: JSON.stringify({
            kind: "update",
            message: JSON.stringify(legacyReceipt),
            stats: { reason: "update-failure-report-receipt" },
            status: "skipped",
            ts: Date.now(),
          }),
        })
        .where("sentinel_key", "=", key),
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/124");

    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(result).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(result).not.toHaveProperty("url");
    expect(createIssue).not.toHaveBeenCalled();
  });
});
