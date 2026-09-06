import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runInteractiveUpdateFailureAction } from "../../cli/update-cli/update-command-report.js";
import type { RunGithubCli } from "../../infra/github-issue.js";
import {
  readUpdateFailureReportReceipt,
  type RestartSentinelPayload,
} from "../../infra/restart-sentinel.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  runGh: vi.fn<RunGithubCli>(),
  sentinel: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
  select: vi.fn<() => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
}));

vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  select: mocks.select,
  confirm: mocks.confirm,
}));

vi.mock("../../infra/github-issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/github-issue.js")>(
    "../../infra/github-issue.js",
  );
  return {
    ...actual,
    submitGithubIssue: (
      issue: Parameters<typeof actual.submitGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.submitGithubIssue>[2],
    ) => actual.submitGithubIssue(issue, mocks.runGh, hooks),
    reconcileGithubIssue: (
      issue: Parameters<typeof actual.reconcileGithubIssue>[0],
      _runGh: unknown,
      hooks: Parameters<typeof actual.reconcileGithubIssue>[2],
    ) => actual.reconcileGithubIssue(issue, mocks.runGh, hooks),
  };
});
vi.mock("../server-restart-sentinel.js", () => ({
  refreshLatestUpdateRestartSentinel: mocks.sentinel,
}));

const { updateReportHandler } = await import("./update-report.js");
const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
let home: TempHomeEnv;

type ClientAuthority = Pick<
  NonNullable<GatewayRequestHandlerOptions["client"]>,
  "internal" | "authenticatedUserProfile" | "connectionSignal"
>;

async function invoke(
  params: Record<string, unknown>,
  hasCurrentClientAuthority = () => true,
  authority: ClientAuthority = { internal: { operatorRoleActor: { kind: "system" } } },
) {
  const respond = vi.fn<RespondFn>();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "report-run-test", method: "update.report", params },
    params,
    respond,
    hasCurrentClientAuthority,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
      ...authority,
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
  };
  await updateReportHandler(options);
  return respond;
}

function recordFailure(status: "failed" | "rolled-back" = "failed") {
  createUpdateRun({
    runId,
    trigger: "control-ui",
    before: { version: "2026.9.1" },
    target: { kind: "git", sha: "f".repeat(40) },
    origin: { sessionKey: "private-session", doctorHint: "private-command --token private-secret" },
  });
  recordUpdateRunPhase(runId, "validating", {
    step: { step: "build", status: "failed", detail: "private-raw-log" },
  });
  finishUpdateRun(runId, { status, reason: "build-failed", after: { version: "2026.9.2" } });
}

function matchingSentinel(): RestartSentinelPayload {
  return {
    kind: "update",
    status: "error",
    ts: Date.now(),
    stats: {
      runId,
      handoffId: "different-handoff",
      mode: "git",
      reason: "build-failed",
      recovery: { serviceRestartSafe: true, version: "2026.9.1" },
      steps: [
        {
          name: "build",
          command: "private-command",
          log: { exitCode: 2, stderrTail: "private-raw-log" },
        },
      ],
    },
  };
}

async function preview(authority?: ClientAuthority) {
  const respond = await invoke({ action: "preview", attemptId: runId }, undefined, authority);
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "ready", attemptId: runId }),
  );
  const result = respond.mock.calls[0]?.[1];
  if (
    !isRecord(result) ||
    typeof result.previewDigest !== "string" ||
    typeof result.body !== "string"
  ) {
    throw new Error("Missing report preview");
  }
  return { body: result.body, previewDigest: result.previewDigest };
}

async function reportFiles() {
  return await fs
    .readdir(path.join(home.home, ".openclaw", "update-reports"))
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-report-run-");
  mocks.select.mockReset().mockResolvedValue("report");
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.sentinel.mockReset().mockResolvedValue(null);
  mocks.runGh.mockReset().mockImplementation(async (args) => ({
    started: true,
    status: 0,
    stdout: Buffer.from(args[0] === "auth" ? "" : issueUrl),
  }));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await home.restore();
});

describe("Report action from the authoritative update ledger", () => {
  it.each([
    { reason: "dirty", reportable: true },
    { reason: "not-git-install", reportable: true },
    { reason: "already-current", reportable: false },
    { reason: "dry-run", reportable: false },
    { reason: "cancelled", reportable: false },
  ])(
    "keeps skipped $reason reporting aligned with the actual outcome",
    async ({ reason, reportable }) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      finishUpdateRun(runId, { status: "skipped", reason });
      const respond = await invoke({ action: "preview", attemptId: runId });
      if (reportable) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "ready",
            attemptId: runId,
            body: expect.stringContaining(reason),
          }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(mocks.runGh).not.toHaveBeenCalled();
      expect(await reportFiles()).toEqual([]);
    },
  );

  it.each(["failed", "rolled-back"] as const)(
    "previews %s without a sentinel and never treats status as verified rollback",
    async (status) => {
      recordFailure(status);
      const result = await preview();
      expect(result.body).toContain("f".repeat(40));
      expect(result.body).toContain("build");
      expect(result.body).toContain("2026.9.1");
      expect(result.body).toContain("2026.9.2");
      expect(result.body).toContain("Rollback outcome: not recorded");
      expect(result.body).not.toContain("private-");
      expect(Buffer.byteLength(result.body)).toBeLessThan(16_000);
      expect(await reportFiles()).toEqual([]);
      expect(mocks.runGh).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "includes rollback/exit evidence only from a matching final sentinel: %s",
    async (matches) => {
      recordFailure();
      const sentinel = matchingSentinel();
      mocks.sentinel.mockResolvedValue({
        ...sentinel,
        stats: {
          ...sentinel.stats,
          runId: matches ? runId : "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        },
      });
      const result = await preview();
      expect(result.body.includes("verified safe to restart")).toBe(matches);
      expect(result.body.includes("exit 2")).toBe(matches);
      expect(result.body).not.toContain("private-");
    },
  );

  it.each(["running", "succeeded"] as const)(
    "refuses a retained failed sentinel while the canonical run is %s",
    async (status) => {
      createUpdateRun({ runId, trigger: "control-ui" });
      if (status === "succeeded") {
        finishUpdateRun(runId, { status });
      }
      mocks.sentinel.mockResolvedValue(matchingSentinel());
      const respond = await invoke({ action: "preview", attemptId: runId });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(await reportFiles()).toEqual([]);
      expect(mocks.runGh).not.toHaveBeenCalled();
    },
  );

  it("reuses the durable created URL on duplicate submission without repeating transport", async () => {
    recordFailure();
    const { previewDigest } = await preview();
    const params = { action: "submit", attemptId: runId, previewDigest };
    const first = await invoke(params);
    const second = await invoke(params);
    expect(first).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "created", url: issueUrl }),
    );
    expect(second).toHaveBeenCalledWith(true, expect.objectContaining({ url: issueUrl }));
    expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
    expect(await reportFiles()).toEqual([]);
  });

  it.each([
    { outcome: "created", changedPreview: false },
    { outcome: "created", changedPreview: true },
    { outcome: "pending", changedPreview: false },
    { outcome: "pending", changedPreview: true },
  ] as const)(
    "reuses CLI $outcome across Gateway reconnect, changed preview: $changedPreview",
    async ({ outcome, changedPreview }) => {
      recordFailure();
      mocks.runGh.mockImplementation(async (args) => {
        if (args[0] === "auth") {
          return { started: true, status: 0, stdout: Buffer.alloc(0) };
        }
        if (args[0] === "issue") {
          expect(args[1]).toBe("list");
          return { started: true, status: 0, stdout: Buffer.from("[]") };
        }
        expect(args[0]).toBe("api");
        return outcome === "created"
          ? { started: true, status: 0, stdout: Buffer.from(issueUrl) }
          : { started: true, status: 1, stdout: Buffer.alloc(0) };
      });
      const runtime = { log: vi.fn(), error: vi.fn() };
      await expect(
        runInteractiveUpdateFailureAction({
          attemptId: runId,
          env: process.env,
          result: {
            status: "error",
            mode: "git",
            reason: "build-failed",
            before: { version: "2026.9.1" },
            after: {
              version: changedPreview ? "2026.9.3" : "2026.9.2",
              upstreamRef: "f".repeat(40),
            },
            steps: [
              { name: "validating", command: "", cwd: "", durationMs: 0, exitCode: null },
              { name: "build", command: "", cwd: "", durationMs: 0, exitCode: null },
            ],
            durationMs: 1,
          },
          runtime,
        }),
      ).resolves.toBe("handled");
      expect(runtime.error).not.toHaveBeenCalled();
      const createPhases = () =>
        mocks.runGh.mock.calls.map(([args]) => args[0]).filter((kind) => kind !== "issue");
      expect(createPhases()).toEqual(["auth", "api"]);
      closeOpenClawStateDatabaseForTest();
      expect(readUpdateFailureReportReceipt(runId)).toMatchObject({ status: outcome });

      const { body, previewDigest } = await preview();
      if (!changedPreview) {
        expect(runtime.log).toHaveBeenCalledWith(body);
      }
      expect(readUpdateFailureReportReceipt(runId)?.previewDigest === previewDigest).toBe(
        !changedPreview,
      );
      const response = await invoke({ action: "submit", attemptId: runId, previewDigest });
      expect(response).toHaveBeenCalledWith(
        true,
        expect.objectContaining(
          outcome === "created" ? { status: "duplicate" } : { status: "pending" },
        ),
      );
      if (outcome === "created" && !changedPreview) {
        expect(response.mock.calls[0]?.[1]).toMatchObject({ url: issueUrl });
      } else {
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("url");
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("fallbackUrl");
      }
      expect(createPhases()).toEqual(["auth", "api"]);

      const nextRunId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      createUpdateRun({ runId: nextRunId, trigger: "cli" });
      finishUpdateRun(nextRunId, { status: "failed", reason: "build-failed" });
      const nextPreview = await invoke({ action: "preview", attemptId: nextRunId });
      const nextResult = nextPreview.mock.calls[0]?.[1];
      if (!isRecord(nextResult) || typeof nextResult.previewDigest !== "string") {
        throw new Error("Missing distinct-run report preview");
      }
      await invoke({
        action: "submit",
        attemptId: nextRunId,
        previewDigest: nextResult.previewDigest,
      });
      expect(createPhases()).toEqual(["auth", "api", "auth", "api"]);
      expect(readUpdateFailureReportReceipt(nextRunId)).toMatchObject({ status: outcome });
      expect(readUpdateFailureReportReceipt(runId)).toMatchObject({ status: outcome });
    },
  );

  it.each(["auth-preflight", "attempt-validation"] as const)(
    "refuses a retired connection during %s and permits explicit resubmission after reconnect",
    async (pauseAt) => {
      recordFailure();
      const connection = new AbortController();
      const authority: ClientAuthority = {
        connectionSignal: connection.signal,
        authenticatedUserProfile: {
          profileId: GATEWAY_OWNER_PROFILE_ID,
          displayName: null,
          hasAvatar: false,
          updatedAt: 0,
        },
      };
      const { previewDigest } = await preview(authority);
      const paused = createDeferred();
      const resume = createDeferred();
      mocks.runGh.mockImplementationOnce(async (args) => {
        expect(args[0]).toBe("auth");
        if (pauseAt === "auth-preflight") {
          paused.resolve();
          await resume.promise;
        } else {
          mocks.sentinel.mockImplementationOnce(async () => {
            paused.resolve();
            await resume.promise;
            return null;
          });
        }
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      const params = { action: "submit", attemptId: runId, previewDigest };
      const submitting = invoke(params, () => true, authority);
      await paused.promise;
      // The host retires the socket without changing its admitted auth generation.
      connection.abort();
      resume.resolve();
      const respond = await submitting;
      expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth"]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(readUpdateFailureReportReceipt(runId)).toBeNull();
      expect(await reportFiles()).toEqual([]);

      const reconnected = { ...authority, connectionSignal: new AbortController().signal };
      const retried = await invoke(params, () => true, reconnected);
      expect(retried).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "created", url: issueUrl }),
      );
      expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "auth", "api"]);
      expect(await reportFiles()).toEqual([]);
    },
  );

  it("does not prepare a preview for an already-retired connection", async () => {
    recordFailure();
    const connection = new AbortController();
    connection.abort();
    const respond = await invoke({ action: "preview", attemptId: runId }, () => true, {
      internal: { operatorRoleActor: { kind: "system" } },
      connectionSignal: connection.signal,
    });
    expect(respond).not.toHaveBeenCalled();
    expect(mocks.sentinel).not.toHaveBeenCalled();
    expect(readUpdateFailureReportReceipt(runId)).toBeNull();
    expect(await reportFiles()).toEqual([]);
    expect(mocks.runGh).not.toHaveBeenCalled();
  });

  it("retains a confirmed created URL if the connection retires after issue creation", async () => {
    recordFailure();
    const connection = new AbortController();
    const authority: ClientAuthority = {
      internal: { operatorRoleActor: { kind: "system" } },
      connectionSignal: connection.signal,
    };
    const { previewDigest } = await preview(authority);
    mocks.runGh.mockImplementation(async (args) => {
      if (args[0] === "api") {
        connection.abort();
        return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
      }
      return { started: true, status: 0, stdout: Buffer.alloc(0) };
    });
    const params = { action: "submit", attemptId: runId, previewDigest };
    await invoke(params, () => true, authority);
    closeOpenClawStateDatabaseForTest();
    expect(readUpdateFailureReportReceipt(runId)).toMatchObject({
      status: "created",
      url: issueUrl,
    });
    const reconnected = await invoke(params, () => true, {
      ...authority,
      connectionSignal: new AbortController().signal,
    });
    expect(reconnected).toHaveBeenCalledWith(true, expect.objectContaining({ url: issueUrl }));
    expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
    expect(await reportFiles()).toEqual([]);
  });

  it.each(["replacement-run", "duplicate-finalization", "changed-sentinel"] as const)(
    "handles %s during auth preflight using authoritative final facts",
    async (change) => {
      recordFailure();
      mocks.sentinel.mockResolvedValue(matchingSentinel());
      const { previewDigest } = await preview();
      mocks.runGh.mockImplementation(async (args) => {
        if (args[0] === "api") {
          expect(change).toBe("duplicate-finalization");
          return { started: true, status: 0, stdout: Buffer.from(issueUrl) };
        }
        expect(args[0]).toBe("auth");
        if (change === "replacement-run") {
          createUpdateRun({ trigger: "control-ui" });
        } else if (change === "duplicate-finalization") {
          const retained = finishUpdateRun(runId, {
            status: "failed",
            reason: "build-failed",
            after: { version: "2026.9.3" },
          });
          expect(retained.after.version).toBe("2026.9.2");
        } else {
          const sentinel = matchingSentinel();
          mocks.sentinel.mockResolvedValue({
            ...sentinel,
            stats: {
              ...sentinel.stats,
              recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            },
          });
        }
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      const respond = await invoke({ action: "submit", attemptId: runId, previewDigest });
      if (change === "duplicate-finalization") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "created", url: issueUrl }),
        );
        expect(mocks.runGh.mock.calls.map(([args]) => args[0])).toEqual(["auth", "api"]);
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(mocks.runGh).toHaveBeenCalledOnce();
      }
      expect(await reportFiles()).toEqual([]);
    },
  );
});
