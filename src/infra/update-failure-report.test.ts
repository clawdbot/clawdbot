import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { VERSION } from "../version.js";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import {
  mockCreatedIssue,
  mockFallbackIssue,
  mockFallbackAfterIssueCreateNoStart,
} from "./update-failure-report.test-support.js";
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

function currentSavedReportArtifactPath(prepared: PreparedReport, stateDir: string): string {
  const receipt = readUpdateFailureReportReceipt(prepared.attemptId, {
    OPENCLAW_STATE_DIR: stateDir,
  });
  if (!receipt) {
    throw new Error("expected an authoritative update report receipt");
  }
  return savedReportArtifactPath(
    prepared,
    receipt.reservationId,
    receipt.previewDigest ?? prepared.previewDigest,
  );
}

async function listSavedReportArtifacts(prepared: PreparedReport): Promise<string[]> {
  const parsed = path.parse(prepared.savedReportPath);
  const entries = await fs.readdir(parsed.dir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => entry.startsWith(`${parsed.name}.`) && entry.endsWith(parsed.ext))
    .map((entry) => path.join(parsed.dir, entry));
}

function failedUpdate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token raw-command-secret",
        cwd: "/Users/private/openclaw",
        durationMs: 12,
        exitCode: 1,
        stdoutTail: "raw chat and log output must not be copied",
        stderrTail: "token=raw-log-secret /Users/private/openclaw/build.log",
      },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
    ...overrides,
  };
}

describe("update failure report", () => {
  it("excludes a later advisory step when selecting the failed phase", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-advisory-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-advisory-phase",
        result: failedUpdate({
          steps: [
            failedUpdate().steps[0]!,
            {
              name: "post-install doctor",
              command: "openclaw doctor",
              cwd: "/tmp/openclaw",
              durationMs: 5,
              exitCode: 86,
              advisory: {
                kind: "package-post-install-doctor",
                message: "recoverable repair warning",
              },
            },
          ],
        }),
      },
      { stateDir },
    );

    expect(prepared.title).toBe(`Update failure: build (${VERSION})`);
    expect(prepared.body).toContain("Failed phase: build");
    expect(prepared.body).not.toContain("post-install doctor");
  });

  it("saves only allowlisted, redacted, Unicode-safe report facts for fallback", async () => {
    const home = tempDirs.make("openclaw-update-report-");
    const stateDir = path.join(home, ".openclaw");
    const secret = "sk-test-update-report-secret-1234567890";
    const emoji = "🦞".repeat(2_000);
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-redaction",
        error: `opaque raw chat payload token=${secret} ${home}/private/error.log`,
        result: failedUpdate({
          reason:
            "build-failed at /Users/Alice Smith/private/customer list.txt after checksum mismatch",
          steps: [
            {
              ...failedUpdate().steps[0]!,
              name: `Command failed: /usr/local/bin/openclaw doctor --fix ${home}/source token=${secret}`,
            },
          ],
        }),
        target: [
          `origin/main token=${secret}`,
          "windows C:\\Users\\Alice Smith\\private\\project after windows marker",
          "unc \\\\server\\Alice Smith\\private\\project after unc marker",
          "rooted \\Users\\Alice Smith\\private\\rooted-secret.txt after rooted marker",
          'quoted "/Users/Alice Smith/private project" after quoted marker',
          "openclaw.exe doctor --token openclaw-exe-secret",
          '"npm.cmd" install --token npm-cmd-secret',
          "npm.ps1 install --token npm-ps1-secret",
          '"PowerShell.EXE" -EncodedCommand powershell-exe-secret',
          '"cmd.exe" /c echo cmd-exe-secret',
          emoji,
        ].join("\n"),
      },
      { env: { HOME: home, OPENCLAW_STATE_DIR: stateDir }, stateDir },
    );
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(
        "https://github.com/openclaw/openclaw/issues/new?title=update",
      ),
      env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    });
    expect(result).toMatchObject({ status: "fallback" });

    const saved = await fs.readFile(result.savedReportPath, "utf8");
    expect(saved).toBe(prepared.body);
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(16_000);
    expect(saved).toContain("Rollback outcome: verified safe to restart");
    expect(saved).toContain("Failed phase:");
    expect(saved).toContain("Update target:");
    expect(saved).toContain("🦞");
    expect(saved).toContain("[redacted-path]");
    expect(saved).not.toContain("�");
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(home);
    expect(saved).not.toContain("/var/lib/openclaw");
    expect(saved).not.toContain("/Users/alice");
    expect(saved).not.toContain("Alice Smith");
    expect(saved).not.toContain("rooted-secret");
    expect(saved).not.toContain("openclaw-exe-secret");
    expect(saved).not.toContain("npm-cmd-secret");
    expect(saved).not.toContain("npm-ps1-secret");
    expect(saved).not.toContain("powershell-exe-secret");
    expect(saved).not.toContain("cmd-exe-secret");
    expect(saved).not.toContain("customer list.txt");
    expect(saved).not.toContain("after checksum mismatch");
    expect(saved).not.toContain("https://example.com/?next=/docs");
    expect(saved).not.toContain("opaque raw chat payload");
    expect(saved).not.toContain("raw-command-secret");
    expect(saved).not.toContain("raw-log-secret");
    expect(saved).not.toContain("raw chat and log output");
    expect(saved).not.toContain("openclaw doctor --fix");
    expect(saved).not.toContain("C:\\Users\\private");
    expect(saved).not.toContain("\\\\server\\private");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(result.savedReportPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(result.savedReportPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports a verified package rollback separately from restart safety", async () => {
    const home = tempDirs.make("openclaw-update-report-package-rollback-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-package-rollback",
        result: failedUpdate({
          recovery: {
            packageRollbackVerified: true,
            reason: "runtime-verification-failed",
            serviceRestartSafe: false,
          },
        }),
      },
      { stateDir: path.join(home, ".openclaw") },
    );

    expect(prepared.body).toContain(
      "Rollback outcome: package rollback verified; service restart not verified (runtime-verification-failed)",
    );
  });

  it("does not substitute restored post-failure state for an unavailable update target", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-target-");
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-restored-target",
        result: failedUpdate({
          after: { version: "2026.8.1" },
          recovery: {
            packageRollbackVerified: true,
            reason: "runtime-verification-failed",
            serviceRestartSafe: false,
          },
        }),
      },
      { stateDir },
    );

    expect(prepared.body).toContain("Update target: exact target unavailable; mode: git");
    expect(prepared.body).not.toContain("Update target: version 2026.8.1");
  });

  it("submits once and rejects a duplicate click for the same attempt", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-once", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const [first, second] = await Promise.all([
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ]);
    const third = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(createIssue).toHaveBeenCalledOnce();
    expect([first.status, second.status].toSorted()).toEqual(["created", "retryable"]);
    expect(third).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the fallback when issue creation cannot start after auth preflight", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-post-auth-spawn-no-start", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockFallbackAfterIssueCreateNoStart(prepared.url);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(second).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, { OPENCLAW_STATE_DIR: stateDir }),
    ).toMatchObject({
      fallbackUrl: prepared.url,
      status: "fallback",
    });
  });

  it("distinguishes an active preparation from ambiguous issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-preparing", result: failedUpdate() },
      { stateDir },
    );
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        "active-owner",
        prepared.previewDigest,
        { OPENCLAW_STATE_DIR: stateDir },
      ),
    ).toMatchObject({ reserved: true });
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ).resolves.toMatchObject({
      message: "This update attempt already has a report preparation in progress.",
      status: "retryable",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("cancels preparation when authority closes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-authority", result: failedUpdate() },
      { stateDir },
    );
    let authorityCurrent = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        authorityCurrent = false;
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).rejects.toThrow("current authenticated client");
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

    authorityCurrent = true;
    const retryCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/124",
        };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("cancels preparation when the canonical attempt changes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-stale", result: failedUpdate() },
      { stateDir },
    );
    let currentAttempt = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        currentAttempt = false;
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

    currentAttempt = true;
    const retryCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/124",
        };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("releases the reservation when the post-preflight attempt refresh throws", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-refresh-error", result: failedUpdate() },
      { stateDir },
    );
    let issueCreateCalls = 0;
    const validateCurrentAttempt = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("restart sentinel refresh unavailable");
      });
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt,
      }),
    ).rejects.toThrow("could not be rechecked");
    expect(issueCreateCalls).toBe(0);
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);

    const retryCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        issueCreateCalls += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/124",
        };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("does not let a pending-reservation loser delete the winner's fallback report", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-pending-fallback-race", result: failedUpdate() },
      { stateDir },
    );
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(true);
    });
    const delayedCreateIssue = vi.fn();
    const delayed = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: delayedCreateIssue,
      stateDir,
      validateCurrentAttempt: () => validationGate,
    });
    const fallbackUrl = prepared.url;
    if (!fallbackUrl) {
      throw new Error("expected an available browser handoff");
    }
    let finishFallback!: () => void;
    const createIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        return await new Promise<{
          url: string;
          reason: "cli-unavailable";
          status: "browser-fallback";
        }>((resolve) => {
          finishFallback = () =>
            resolve({
              url: fallbackUrl,
              reason: "cli-unavailable",
              status: "browser-fallback",
            });
        });
      },
    );
    const winner = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    const winnerReportPath = currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);

    finishValidation();
    const delayedResult = await delayed;
    expect(delayedResult).toMatchObject({ status: "retryable" });
    expect(delayedResult).not.toHaveProperty("fallbackUrl");
    expect(delayedCreateIssue).not.toHaveBeenCalled();
    finishFallback();
    const winnerResult = await winner;
    expect(winnerResult).toMatchObject({ status: "fallback", fallbackUrl });
    expect(winnerResult.savedReportPath).toBe(winnerReportPath);
    expect(await fs.readFile(winnerReportPath, "utf8")).toBe(prepared.body);
  });

  it("does not let expired validation cleanup delete a replacement fallback report", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-validation-cleanup", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(validationGate);
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    await vi.waitFor(() => expect(validateCurrentAttempt).toHaveBeenCalledTimes(2));
    const oldReportPath = currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockFallbackIssue(prepared.url),
      stateDir,
    });
    finishValidation();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
    expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(replacement.savedReportPath).not.toBe(oldReportPath);
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a delayed cleanup worker delete a successor report artifact", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-delayed-cleanup-successor", result: failedUpdate() },
      { stateDir },
    );
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(validationGate);
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    await vi.waitFor(() => expect(validateCurrentAttempt).toHaveBeenCalledTimes(2));
    const oldReportPath = currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(prepared.body);

    const realRm = fs.rm.bind(fs);
    let releaseFirstCleanup!: () => void;
    const firstCleanupGate = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let firstCleanupStarted!: () => void;
    const firstCleanupStart = new Promise<void>((resolve) => {
      firstCleanupStarted = resolve;
    });
    let blockedFirstCleanup = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === oldReportPath && !blockedFirstCleanup) {
        blockedFirstCleanup = true;
        firstCleanupStarted();
        await firstCleanupGate;
      }
      return await realRm(target, options);
    });

    finishValidation();
    await firstCleanupStart;
    let replacement: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    let oldResult: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: mockFallbackIssue(prepared.url),
        stateDir,
      });
      expect(replacement).toMatchObject({ fallbackUrl: prepared.url, status: "fallback" });
      expect(replacement.savedReportPath).not.toBe(oldReportPath);
      expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
      releaseFirstCleanup();
      oldResult = await oldSubmission;
    } finally {
      releaseFirstCleanup();
      rm.mockRestore();
    }

    expect(oldResult).toMatchObject({ fallbackUrl: prepared.url, status: "duplicate" });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates a replacement from an expired owner's mismatched report artifact", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const attemptId = "attempt-expired-mismatched-report";
    const oldPrepared = await prepareUpdateFailureReport(
      { attemptId, result: failedUpdate() },
      { stateDir },
    );
    const replacementPrepared = await prepareUpdateFailureReport(
      { attemptId, result: failedUpdate({ reason: "install-failed" }) },
      { stateDir },
    );
    expect(replacementPrepared.body).not.toBe(oldPrepared.body);
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(false);
    });
    const validateCurrentAttempt = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(validationGate);
    const oldCreateIssue = vi.fn();
    const oldSubmission = submitUpdateFailureReport(oldPrepared, oldPrepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
      validateCurrentAttempt,
    });
    await vi.waitFor(() => expect(validateCurrentAttempt).toHaveBeenCalledTimes(2));
    const oldReportPath = currentSavedReportArtifactPath(oldPrepared, stateDir);
    expect(await fs.readFile(`${oldReportPath}.pending`, "utf8")).toBe(oldPrepared.body);

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(
      replacementPrepared,
      replacementPrepared.previewDigest,
      { createIssue: mockFallbackIssue(replacementPrepared.url), stateDir },
    );
    finishValidation();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({
      fallbackUrl: replacementPrepared.url,
      status: "fallback",
    });
    expect(oldResult).toMatchObject({
      message: expect.stringContaining("different reviewed preview"),
      status: "duplicate",
    });
    expect(oldResult).not.toHaveProperty("fallbackUrl");
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(replacement.savedReportPath).not.toBe(oldReportPath);
    expect(await fs.readFile(replacement.savedReportPath, "utf8")).toBe(replacementPrepared.body);
    await expect(fs.stat(`${oldReportPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fences an expired staged writer and recovers its interrupted cleanup", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-preparation", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseOldWrite!: () => void;
    const oldWriteGate = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    let oldWriteStarted!: () => void;
    const oldWriteStartedGate = new Promise<void>((resolve) => {
      oldWriteStarted = resolve;
    });
    let delayFirstStagedWrite = true;
    const writeFile = fs.writeFile;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (delayFirstStagedWrite && typeof args[0] === "string" && args[0].endsWith(".pending")) {
        delayFirstStagedWrite = false;
        oldWriteStarted();
        await oldWriteGate;
      }
      return writeFile(...args);
    });
    const oldCreateIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/122");

    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
    });
    await oldWriteStartedGate;
    const oldReportPath = currentSavedReportArtifactPath(prepared, stateDir);
    const oldStagedReportPath = `${oldReportPath}.pending`;
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "preparing" });

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    await fs.mkdir(path.dirname(oldReportPath), { mode: 0o700, recursive: true });
    const rm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0] === oldStagedReportPath) {
        throw new Error("simulated late-owner cleanup interruption");
      }
      return rm(...args);
    });
    releaseOldWrite();
    const oldResult = await oldSubmission.finally(() => {
      rmSpy.mockRestore();
      writeSpy.mockRestore();
    });
    now.mockRestore();

    expect(replacement).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldCreateIssue).not.toHaveBeenCalled();
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({
      artifactSweep: "pending",
      status: "created",
    });
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(oldStagedReportPath, "utf8")).resolves.toBe(prepared.body);

    const reconnectCreateIssue = mockCreatedIssue(
      "https://github.com/openclaw/openclaw/issues/124",
    );
    const reconnected = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: reconnectCreateIssue,
      stateDir,
    });

    expect(reconnected).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(reconnectCreateIssue).not.toHaveBeenCalled();
    await expect(fs.stat(oldReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldStagedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
  });

  it("fences an expired sweep holder before listing successor artifacts", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-sweep-holder", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const expiredReservationId = "expired-sweep-reservation";
    expect(
      reserveUpdateFailureReportReceipt(
        prepared.attemptId,
        expiredReservationId,
        prepared.previewDigest,
        { OPENCLAW_STATE_DIR: stateDir },
      ),
    ).toMatchObject({ reserved: true });
    const retiredPath = savedReportArtifactPath(prepared, expiredReservationId);
    await fs.mkdir(path.dirname(retiredPath), { mode: 0o700, recursive: true });
    await fs.writeFile(`${retiredPath}.pending`, prepared.body, { mode: 0o600 });
    nowMs += 10 * 60_000;
    expect(
      beginStaleUpdateFailureReportReceiptCleanup(prepared.attemptId, expiredReservationId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(true);
    expect(
      completeUpdateFailureReportReceiptCleanup(prepared.attemptId, expiredReservationId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(true);

    let releaseExpiredSweep!: () => void;
    const expiredSweepGate = new Promise<void>((resolve) => {
      releaseExpiredSweep = resolve;
    });
    let expiredSweepClaimed!: () => void;
    const expiredSweepClaimedGate = new Promise<void>((resolve) => {
      expiredSweepClaimed = resolve;
    });
    const staleListCandidates = vi.fn(async () => {
      throw new Error("an expired sweep holder must not scan after takeover");
    });
    const staleCreateIssue = vi.fn();
    const staleSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      artifactSweepHooks: {
        beforeList: async () => {
          expiredSweepClaimed();
          await expiredSweepGate;
        },
        listCandidates: staleListCandidates,
      },
      createIssue: staleCreateIssue,
      stateDir,
    });
    await expiredSweepClaimedGate;

    nowMs += 10 * 60_000;
    let releaseSuccessorTransport!: () => void;
    const successorTransportGate = new Promise<void>((resolve) => {
      releaseSuccessorTransport = resolve;
    });
    let successorPublished!: () => void;
    const successorPublishedGate = new Promise<void>((resolve) => {
      successorPublished = resolve;
    });
    let transportCount = 0;
    const successorCreateIssue = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        successorPublished();
        await successorTransportGate;
        await hooks.afterAuthPreflight?.();
        (await hooks.beforeIssueCreate?.())?.();
        transportCount += 1;
        return {
          status: "created" as const,
          url: "https://github.com/openclaw/openclaw/issues/123",
        };
      },
    );
    const successorSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: successorCreateIssue,
      stateDir,
    });
    await successorPublishedGate;
    const successorPath = currentSavedReportArtifactPath(prepared, stateDir);
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(`${retiredPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });

    releaseExpiredSweep();
    const staleResult = await staleSubmission;
    expect(staleResult).toMatchObject({ status: "retryable" });
    expect(staleListCandidates).not.toHaveBeenCalled();
    expect(staleCreateIssue).not.toHaveBeenCalled();
    expect(await fs.readFile(successorPath, "utf8")).toBe(prepared.body);

    releaseSuccessorTransport();
    const successorResult = await successorSubmission;
    expect(successorResult).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(transportCount).toBe(1);
    expect(successorCreateIssue).toHaveBeenCalledOnce();

    const reconnectCreateIssue = mockCreatedIssue(
      "https://github.com/openclaw/openclaw/issues/124",
    );
    const reconnected = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: reconnectCreateIssue,
      stateDir,
    });
    now.mockRestore();

    expect(reconnected).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(reconnectCreateIssue).not.toHaveBeenCalled();
    await expect(listSavedReportArtifacts(prepared)).resolves.toEqual([]);
    await expect(fs.stat(`${retiredPath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish a fallback after its preparation lease is replaced", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-fallback-preparation", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseOldFallback!: () => void;
    const oldFallbackGate = new Promise<void>((resolve) => {
      releaseOldFallback = resolve;
    });
    const oldFallback = vi.fn(
      async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        await oldFallbackGate;
        return {
          url: prepared.url!,
          reason: "cli-unavailable" as const,
          status: "browser-fallback" as const,
        };
      },
    );
    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldFallback,
      stateDir,
    });
    await vi.waitFor(() => expect(oldFallback).toHaveBeenCalledOnce());

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    releaseOldFallback();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).not.toHaveProperty("fallbackUrl");
    await expect(fs.stat(`${prepared.savedReportPath}.result.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("receipt database unavailable");
      },
    ],
  ])("returns a created URL without retrying when receipt finalization %s", async (_, fail) => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-finalize-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(finalizeUpdateFailureReportReceipt).mockImplementationOnce(fail);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(finalizeReceipt).toHaveBeenCalledTimes(2);
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hide a created result when saved-report cleanup fails", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-cleanup-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        path.dirname(String(target)) === path.dirname(prepared.savedReportPath) &&
        path.basename(String(target)).startsWith(`${path.parse(prepared.savedReportPath).name}.`)
      ) {
        throw new Error("simulated saved-report cleanup failure");
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
    expect(await fs.readFile(first.savedReportPath, "utf8")).toBe(prepared.body);
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(first.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
