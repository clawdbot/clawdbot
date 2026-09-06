import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { GithubIssueSubmitHooks, RunGithubCli } from "../../../infra/github-issue.js";
import type { RestartSentinelPayload } from "../../../infra/restart-sentinel.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../agent-runtime-identity-token.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const mocks = vi.hoisted(() => ({
  submitGithubIssue: vi.fn(),
  getLatest: vi.fn<() => RestartSentinelPayload | null>(),
  refreshLatest: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
}));

vi.mock("../../../infra/github-issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
    "../../../infra/github-issue.js",
  );
  return { ...actual, submitGithubIssue: mocks.submitGithubIssue };
});

vi.mock("../../server-restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../server-restart-sentinel.js")>(
    "../../server-restart-sentinel.js",
  );
  return {
    ...actual,
    getLatestUpdateRestartSentinel: mocks.getLatest,
    refreshLatestUpdateRestartSentinel: mocks.refreshLatest,
  };
});

const { updateReportHandler } = await import("../../server-methods/update-report.js");

const failure: RestartSentinelPayload = {
  kind: "update",
  status: "error",
  ts: 500,
  stats: {
    handoffId: "authority-proof",
    mode: "npm",
    target: "openclaw@next",
    reason: "doctor-failed",
    before: { version: "2026.8.1" },
    after: { version: "2026.8.2" },
    steps: [
      { name: "doctor", command: "openclaw doctor --fix", durationMs: 10, log: { exitCode: 1 } },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
  },
};

const originalWriteFile = fs.writeFile.bind(fs);
let stateDir = "";

function countReportReceipts(): number {
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!existsSync(databasePath)) {
    return 0;
  }
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM gateway_restart_sentinel WHERE sentinel_key LIKE 'update-failure-report:%'",
        )
        .get() as { count: number };
      return row.count;
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function countReportFiles(): Promise<number> {
  try {
    return (await fs.readdir(path.join(stateDir, "update-reports"))).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function createReportHarness(params: { getGeneration: () => string }) {
  let nextFinished = createDeferredCore();
  const handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]> = async (
    options,
  ) => {
    try {
      await updateReportHandler(options as never);
    } finally {
      const finished = nextFinished;
      nextFinished = createDeferredCore();
      finished.resolve();
    }
  };
  const harness = createDispatchTestHarness({
    extraHandlers: { "update.report": handler },
    buildRequestContext: () => ({
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
    getRequiredSharedGatewaySessionGeneration: params.getGeneration,
  });
  return { harness, waitForNextHandler: () => nextFinished.promise };
}

function grantReportAuthority(
  client: ReturnType<typeof createOperatorWsClient>,
  authority: "gateway-owner" | "system-admin",
): void {
  if (authority === "system-admin") {
    client.internal = { operatorRoleActor: { kind: "system" } };
    return;
  }
  client.authenticatedUserProfile = {
    profileId: GATEWAY_OWNER_PROFILE_ID,
    displayName: "Gateway owner",
    avatarRevision: "owner-avatar",
    hasAvatar: false,
    updatedAt: 1,
  };
}

function identifyNonOwner(client: ReturnType<typeof createOperatorWsClient>): void {
  client.authenticatedUserProfile = {
    profileId: "profile-non-owner",
    displayName: "Delegated operator",
    avatarRevision: "operator-avatar",
    hasAvatar: false,
    updatedAt: 1,
  };
}

async function dispatchPreview(params: {
  harness: ReturnType<typeof createReportHarness>["harness"];
  client: ReturnType<typeof createOperatorWsClient>;
  id: string;
}): Promise<string> {
  await params.harness.dispatcher.dispatch(
    {
      type: "req",
      id: params.id,
      method: "update.report",
      params: { action: "preview", attemptId: "authority-proof" },
    },
    params.client,
  );
  const response = await params.harness.awaitResponseFrame(params.id);
  expect(response).toMatchObject({ ok: true, payload: { status: "ready" } });
  return (response.payload as { previewDigest: string }).previewDigest;
}

async function dispatchSubmit(params: {
  harness: ReturnType<typeof createReportHarness>["harness"];
  client: ReturnType<typeof createOperatorWsClient>;
  id: string;
  previewDigest: string;
}) {
  await params.harness.dispatcher.dispatch(
    {
      type: "req",
      id: params.id,
      method: "update.report",
      params: {
        action: "submit",
        attemptId: "authority-proof",
        previewDigest: params.previewDigest,
      },
    },
    params.client,
  );
}

describe("update report live authority boundary", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-report-authority-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    mocks.getLatest.mockReturnValue(failure);
    mocks.refreshLatest.mockResolvedValue(failure);
    mocks.submitGithubIssue.mockImplementation(
      async (_issue: unknown, _runGh: unknown, hooks: GithubIssueSubmitHooks) => {
        await hooks.afterAuthPreflight?.();
        const commitIssueCreate = await hooks.beforeIssueCreate?.();
        commitIssueCreate?.();
        return {
          status: "created",
          url: "https://github.com/openclaw/openclaw/issues/999999",
        };
      },
    );
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { force: true, recursive: true });
  });

  it.each(["gateway-owner", "system-admin"] as const)(
    "permits a current %s to preview, reserve a receipt, and reach the GitHub CLI transport",
    async (authority) => {
      const generation = "current";
      const client = createOperatorWsClient({ connId: `report-current-${authority}` });
      grantReportAuthority(client, authority);
      client.usesSharedGatewayAuth = true;
      client.sharedGatewaySessionGeneration = generation;
      const { harness } = createReportHarness({ getGeneration: () => generation });
      const previewDigest = await dispatchPreview({ client, harness, id: "preview-allowed" });
      expect(await countReportFiles()).toBe(0);

      await dispatchSubmit({ client, harness, id: "allowed", previewDigest });
      const response = await harness.awaitResponseFrame("allowed");

      expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();
      expect(await countReportFiles()).toBe(0);
      expect(countReportReceipts()).toBe(1);
      expect(response).toMatchObject({
        ok: true,
        payload: {
          status: "created",
          url: "https://github.com/openclaw/openclaw/issues/999999",
        },
      });
    },
  );

  it.each([
    { authority: "gateway-owner", retire: true, boundary: "auth" },
    { authority: "system-admin", retire: true, boundary: "auth" },
    { authority: "gateway-owner", retire: false, boundary: "auth" },
    { authority: "system-admin", retire: false, boundary: "auth" },
    { authority: "gateway-owner", retire: true, boundary: "prepared" },
    { authority: "system-admin", retire: true, boundary: "prepared" },
    { authority: "gateway-owner", retire: false, boundary: "prepared" },
    { authority: "system-admin", retire: false, boundary: "prepared" },
  ] as const)(
    "revalidates delegated $authority authority at $boundary, retired=$retire",
    async ({ authority, retire, boundary }) => {
      const transport = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
        "../../../infra/github-issue.js",
      );
      const client = createOperatorWsClient({ connId: `report-runtime-${authority}-${retire}` });
      grantReportAuthority(client, authority);
      const claim = claimAgentRunDelegatedAuthority({
        instanceId: client.connId,
        runId: client.connId,
      });
      const identity = {
        kind: "agentRuntime" as const,
        agentId: "main",
        sessionKey: "agent:main:report-authority",
        operationalRunInstance: claim.operationalRunInstance,
        delegatedAuthority: { ...claim, kind: "local" as const },
      };
      client.internal = { ...client.internal, agentRuntimeIdentity: identity };
      const validateAuthority = createAgentRuntimeApprovalAuthorityValidator();
      const { harness, waitForNextHandler } = createReportHarness({
        getGeneration: () => "current",
      });
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const runGh = vi.fn<RunGithubCli>(async (args) => {
        if (args[0] === "auth") {
          entered.resolve();
          await released.promise;
          return { started: true, status: 0, stdout: Buffer.alloc(0) };
        }
        expect(args).toContain("POST");
        expect(validateAuthority(identity)).toBe(true);
        return {
          started: true,
          status: 0,
          stdout: Buffer.from(
            "HTTP/2.0 201 Created\nhttps://github.com/openclaw/openclaw/issues/999999\n",
          ),
        };
      });
      mocks.submitGithubIssue.mockImplementationOnce(
        (issue, _runGh, hooks: GithubIssueSubmitHooks) =>
          transport.submitGithubIssue(issue, runGh, {
            ...hooks,
            beforeIssueCreate: async () => {
              if (!hooks.beforeIssueCreate) {
                throw new Error("expected the report preparation hook");
              }
              const commitIssueCreate = await hooks.beforeIssueCreate();
              if (boundary === "prepared" && retire) {
                queueMicrotask(() => releaseAgentRunDelegatedAuthority(claim));
              }
              return commitIssueCreate;
            },
          }),
      );
      try {
        expect(validateAuthority(identity)).toBe(true);
        const previewDigest = await dispatchPreview({ client, harness, id: "runtime-preview" });
        const finished = waitForNextHandler();
        const dispatch = dispatchSubmit({ client, harness, id: "runtime-submit", previewDigest });
        await entered.promise;
        if (retire && boundary === "auth") {
          expect(releaseAgentRunDelegatedAuthority(claim)).toBe(true);
        }
        expect(validateAuthority(identity)).toBe(!(retire && boundary === "auth"));
        expect(client.invalidated).not.toBe(true);
        expect(client.connectionSignal?.aborted).not.toBe(true);
        released.resolve();
        await finished;
        await dispatch;

        expect(validateAuthority(identity)).toBe(!retire);

        expect
          .soft(runGh.mock.calls.map(([args]) => args[0]))
          .toEqual(retire ? ["auth"] : ["auth", "api"]);
        expect.soft(countReportReceipts()).toBe(retire ? 0 : 1);
        expect(await countReportFiles()).toBe(0);
        const response = await harness.awaitResponseFrame("runtime-submit");
        if (retire) {
          expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
          expect(harness.close).toHaveBeenCalledWith(4001, "agent runtime authority closed");
        } else {
          expect(response).toMatchObject({
            ok: true,
            payload: {
              status: "created",
              url: "https://github.com/openclaw/openclaw/issues/999999",
            },
          });
          expect(harness.close).not.toHaveBeenCalled();
        }
      } finally {
        released.resolve();
        releaseAgentRunDelegatedAuthority(claim);
      }
    },
  );

  it.each(["identity", "same-identity-facts"] as const)(
    "refuses changed sentinel $0 during real shared auth preflight",
    async (change) => {
      const transport = await vi.importActual<typeof import("../../../infra/github-issue.js")>(
        "../../../infra/github-issue.js",
      );
      const client = createOperatorWsClient({ connId: `report-changed-${change}` });
      grantReportAuthority(client, "system-admin");
      const { harness, waitForNextHandler } = createReportHarness({
        getGeneration: () => "current",
      });
      const previewDigest = await dispatchPreview({
        client,
        harness,
        id: `preview-changed-${change}`,
      });
      const entered = createDeferredCore();
      const released = createDeferredCore();
      const runGh = vi.fn<RunGithubCli>(async (args) => {
        expect(args[0]).toBe("auth");
        entered.resolve();
        await released.promise;
        return { started: true, status: 0, stdout: Buffer.alloc(0) };
      });
      mocks.submitGithubIssue.mockImplementationOnce((issue, _runGh, hooks) =>
        transport.submitGithubIssue(issue, runGh, hooks),
      );
      const finished = waitForNextHandler();
      const dispatch = dispatchSubmit({ client, harness, id: `changed-${change}`, previewDigest });
      await entered.promise;
      mocks.refreshLatest.mockResolvedValue({
        ...failure,
        stats: {
          ...failure.stats,
          ...(change === "identity" ? { handoffId: "replacement" } : { reason: "rollback-failed" }),
        },
      });
      released.resolve();
      await finished;
      await dispatch;

      expect(runGh).toHaveBeenCalledOnce();
      expect(await countReportFiles()).toBe(0);
      expect(countReportReceipts()).toBe(0);
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `changed-${change}`,
          ok: false,
          error: expect.objectContaining({ code: "INVALID_REQUEST" }),
        }),
      );
    },
  );

  it.each([
    { label: "operator.write", scopes: ["operator.write"] },
    { label: "non-owner administrator", scopes: ["operator.admin"] },
  ])("rejects an identified $label before report state or transport", async ({ scopes }) => {
    const client = createOperatorWsClient({
      connId: `report-denied-${scopes[0]}`,
      scopes,
    });
    identifyNonOwner(client);
    const { harness } = createReportHarness({ getGeneration: () => "current" });

    await harness.dispatcher.dispatch(
      {
        type: "req",
        id: `denied-${scopes[0]}`,
        method: "update.report",
        params: { action: "preview", attemptId: "authority-proof" },
      },
      client,
    );
    const response = await harness.awaitResponseFrame(`denied-${scopes[0]}`);

    expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(mocks.refreshLatest).not.toHaveBeenCalled();
    expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
    expect(await countReportFiles()).toBe(0);
    expect(countReportReceipts()).toBe(0);
  });

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
  ] as const)(
    "blocks issue creation when $change authority closes after auth preflight",
    async (testCase) => {
      let generation = "current";
      const client = createOperatorWsClient({ connId: `report-preflight-${testCase.change}` });
      grantReportAuthority(client, "system-admin");
      if (testCase.change === "shared-auth") {
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = generation;
      }
      const { harness, waitForNextHandler } = createReportHarness({
        getGeneration: () => generation,
      });
      const previewDigest = await dispatchPreview({
        client,
        harness,
        id: `preview-preflight-${testCase.change}`,
      });
      const enteredAuthPreflight = createDeferredCore();
      const releaseAuthPreflight = createDeferredCore();
      let issueCreateCalls = 0;
      mocks.submitGithubIssue.mockImplementationOnce(
        async (_issue: unknown, _runGh: unknown, hooks: GithubIssueSubmitHooks) => {
          await hooks.afterAuthPreflight?.();
          enteredAuthPreflight.resolve();
          await releaseAuthPreflight.promise;
          const commitIssueCreate = await hooks.beforeIssueCreate?.();
          commitIssueCreate?.();
          issueCreateCalls += 1;
          return {
            status: "created",
            url: "https://github.com/openclaw/openclaw/issues/999999",
          };
        },
      );

      const finished = waitForNextHandler();
      const dispatch = dispatchSubmit({
        client,
        harness,
        id: `denied-preflight-${testCase.change}`,
        previewDigest,
      });
      await enteredAuthPreflight.promise;
      if (testCase.change === "shared-auth") {
        generation = "rotated";
      } else {
        client.invalidated = true;
        client.invalidatedReason = "device-token-revoked";
      }
      releaseAuthPreflight.resolve();
      await finished;
      await dispatch;

      expect(harness.close).toHaveBeenCalledWith(4001, testCase.closeReason);
      expect(mocks.submitGithubIssue).toHaveBeenCalledOnce();
      expect(issueCreateCalls).toBe(0);
      expect(await countReportFiles()).toBe(0);
      expect(countReportReceipts()).toBe(0);
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: `denied-preflight-${testCase.change}`, ok: true }),
      );
    },
  );

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
  ] as const)(
    "blocks receipt reservation and GitHub CLI transport after $change authority closes",
    async (testCase) => {
      let generation = "current";
      const client = createOperatorWsClient({ connId: `report-${testCase.change}` });
      grantReportAuthority(client, "system-admin");
      if (testCase.change === "shared-auth") {
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = generation;
      }
      const { harness, waitForNextHandler } = createReportHarness({
        getGeneration: () => generation,
      });
      const previewDigest = await dispatchPreview({
        client,
        harness,
        id: `preview-${testCase.change}`,
      });
      const enteredPreparation = createDeferredCore();
      const releasePreparation = createDeferredCore();
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const result = await originalWriteFile(...args);
        if (
          typeof args[0] === "string" &&
          args[0].includes(`${path.sep}update-reports${path.sep}`)
        ) {
          enteredPreparation.resolve();
          await releasePreparation.promise;
        }
        return result;
      });

      const finished = waitForNextHandler();
      const dispatch = dispatchSubmit({
        client,
        harness,
        id: `denied-${testCase.change}`,
        previewDigest,
      });
      await enteredPreparation.promise;
      if (testCase.change === "shared-auth") {
        generation = "rotated";
      } else {
        client.invalidated = true;
        client.invalidatedReason = "device-token-revoked";
      }
      releasePreparation.resolve();
      await finished;
      await dispatch;

      expect(harness.close).toHaveBeenCalledWith(4001, testCase.closeReason);
      expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
      expect(await countReportFiles()).toBe(0);
      expect(countReportReceipts()).toBe(0);
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: `denied-${testCase.change}`, ok: true }),
      );
    },
  );

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
  ] as const)(
    "blocks preview and leaves no report artifact after $change authority closes",
    async (testCase) => {
      let generation = "current";
      const client = createOperatorWsClient({ connId: `preview-${testCase.change}` });
      grantReportAuthority(client, "system-admin");
      if (testCase.change === "shared-auth") {
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = generation;
      }
      const { harness, waitForNextHandler } = createReportHarness({
        getGeneration: () => generation,
      });
      const enteredRefresh = createDeferredCore();
      const releaseRefresh = createDeferredCore();
      mocks.refreshLatest.mockImplementationOnce(async () => {
        enteredRefresh.resolve();
        await releaseRefresh.promise;
        return failure;
      });

      const finished = waitForNextHandler();
      const dispatch = harness.dispatcher.dispatch(
        {
          type: "req",
          id: `preview-denied-${testCase.change}`,
          method: "update.report",
          params: { action: "preview", attemptId: "authority-proof" },
        },
        client,
      );
      await enteredRefresh.promise;
      if (testCase.change === "shared-auth") {
        generation = "rotated";
      } else {
        client.invalidated = true;
        client.invalidatedReason = "device-token-revoked";
      }
      releaseRefresh.resolve();
      await finished;
      await dispatch;

      expect(harness.close).toHaveBeenCalledWith(4001, testCase.closeReason);
      expect(mocks.submitGithubIssue).not.toHaveBeenCalled();
      expect(await countReportFiles()).toBe(0);
      expect(countReportReceipts()).toBe(0);
      expect(harness.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: `preview-denied-${testCase.change}`, ok: true }),
      );
    },
  );
});
