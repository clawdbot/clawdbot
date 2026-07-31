// Unified approval handlers test safe projections, authorization, and one-shot resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalHistoryResult,
  validateApprovalGetResult,
  validateApprovalHistoryResult,
  validateApprovalResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailed, insertOperatorApproval } from "../operator-approval-store.js";

function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}
import { cancelRunBoundExecApprovals } from "./approval-run-cancellation.js";
import { createApprovalHandlers } from "./approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const tempDirs: string[] = [];
type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
const managersForCleanup: Array<{
  listPendingRecords(): Array<{ id: string }>;
  expire(id: string, resolvedBy?: string | null): boolean;
}> = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-handler-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createManagers(databaseOptions: OpenClawStateDatabaseOptions) {
  const persistence = { runtimeEpoch: "approval-handler-test", databaseOptions };
  const managers = {
    exec: new ExecApprovalManager<ExecApprovalRequestPayload>({
      approvalKind: "exec",
      persistence,
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      resolveAudienceSessionKeys: (source) => [source, "agent:main:parent"],
    }),
    plugin: new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence,
      resolveAllowedDecisions: resolvePluginApprovalRequestAllowedDecisions,
      resolveAudienceSessionKeys: (source) => [source, "agent:main:parent"],
    }),
    systemAgent: new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      persistence,
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      resolveAudienceSessionKeys: (source) => [source, "agent:main:parent"],
    }),
  };
  managersForCleanup.push(managers.exec, managers.plugin, managers.systemAgent);
  return managers;
}

function deleteDurableApproval(databaseOptions: OpenClawStateDatabaseOptions, id: string): void {
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("operator_approvals").where("approval_id", "=", id),
  );
}

function corruptDurableApprovalPresentation(
  databaseOptions: OpenClawStateDatabaseOptions,
  id: string,
): void {
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb
      .updateTable("operator_approvals")
      .set({ presentation_json: "{}" })
      .where("approval_id", "=", id),
  );
}

function registerExec(
  manager: ExecApprovalManager,
  params: {
    id: string;
    request?: Partial<ExecApprovalRequestPayload>;
    expiresAtMs?: number;
    requester?: {
      connId?: string | null;
      deviceId?: string | null;
      clientId?: string | null;
    };
    reviewerDeviceIds?: string[];
  },
) {
  const record = manager.create(
    {
      command: "printf approval-handler",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:child",
      ...params.request,
    },
    600_000,
    params.id,
  );
  record.requestedByConnId = params.requester?.connId ?? null;
  record.requestedByDeviceId =
    params.requester && "deviceId" in params.requester
      ? params.requester.deviceId
      : "requester-device";
  record.requestedByClientId =
    params.requester && "clientId" in params.requester
      ? params.requester.clientId
      : "requester-client";
  record.requestedByDeviceTokenAuth = true;
  record.approvalReviewerDeviceIds = params.reviewerDeviceIds ?? ["reviewer"];
  if (params.expiresAtMs !== undefined) {
    record.expiresAtMs = params.expiresAtMs;
  }
  const decision = manager.register(record, 600_000);
  return { record, decision };
}

function registerPlugin(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    id: string;
    request?: Partial<PluginApprovalRequestPayload>;
    reviewerDeviceIds?: string[];
  },
) {
  const record = manager.create(
    {
      title: "Plugin permission",
      description: "Allow one guarded plugin operation",
      severity: "warning",
      pluginId: "example-plugin",
      toolName: "example-tool",
      agentId: "main",
      sessionKey: "agent:main:child",
      ...params.request,
    },
    600_000,
    params.id,
  );
  record.requestedByDeviceId = "requester-device";
  record.requestedByClientId = "requester-client";
  record.requestedByDeviceTokenAuth = true;
  record.approvalReviewerDeviceIds = params.reviewerDeviceIds ?? ["reviewer"];
  const decision = manager.register(record, 600_000);
  return { record, decision };
}

function registerSystemAgent(
  manager: ExecApprovalManager<SystemAgentApprovalRequestPayload>,
  id: string,
) {
  const record = manager.create(
    {
      title: "OpenClaw change",
      description: "Set gateway.port to 19001",
      command: "Set gateway.port to 19001",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "delegation-1",
    },
    600_000,
    id,
  );
  const decision = manager.register(record, 600_000);
  return { record, decision };
}

function createClient(params: {
  scopes?: string[];
  deviceId?: string;
  internal?: boolean;
  connId?: string;
}): GatewayRequestHandlerOptions["client"] {
  return {
    connId: params.connId ?? (params.deviceId ? `conn-${params.deviceId}` : "conn-no-device"),
    connect: {
      client: { id: "approval-test", displayName: "Approval Test" },
      scopes: params.scopes ?? ["operator.approvals"],
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.internal ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createContext(controlUiBasePath?: string) {
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    approvalEvents: {
      publishRequested: vi.fn(() => 0),
      publishResolved: vi.fn(),
    },
    getApprovalClientConnIds: vi.fn(() => new Set(["approval-client"])),
    getRuntimeConfig: () => ({ gateway: { controlUi: { basePath: controlUiBasePath } } }),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

async function invoke(params: {
  handlers: ReturnType<typeof createApprovalHandlers>;
  method: "approval.get" | "approval.history" | "approval.resolve";
  body: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  context?: GatewayRequestHandlerOptions["context"];
}) {
  const respond = vi.fn();
  const context = params.context ?? createContext();
  await expectDefined(
    params.handlers[params.method],
    "params.handlers[params.method] test invariant",
  )({
    req: { id: "req-1", type: "req", method: params.method, params: params.body },
    params: params.body,
    client: params.client,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  const response = respond.mock.calls[0];
  if (!response) {
    throw new Error("approval handler did not respond");
  }
  return { ok: response[0], result: response[1], error: response[2], context };
}

function approvalFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !("approval" in result)) {
    throw new Error("missing approval response");
  }
  return (result as { approval: Record<string, unknown> }).approval;
}

describe("unified approval handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const manager of managersForCleanup.splice(0)) {
      for (const record of manager.listPendingRecords()) {
        manager.expire(record.id, "test-cleanup");
      }
    }
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("resolves a system-agent proposal only through unified operator approval", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerSystemAgent(managers.systemAgent, "system-agent:proposal-1");
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      systemAgentApprovalManager: managers.systemAgent,
      databaseOptions,
    });
    const context = createContext();

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "system-agent", decision: "allow-once" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "allowed",
        decision: "allow-once",
        presentation: {
          kind: "system-agent",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(context.getApprovalClientConnIds).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
  });

  it("returns mapped terminal history with attribution and a next cursor", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const first = registerExec(managers.exec, { id: "history:first" });
    const second = registerPlugin(managers.plugin, { id: "history:second" });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    for (const [id, kind] of [
      [first.record.id, "exec"],
      [second.record.id, "plugin"],
    ] as const) {
      const response = await invoke({
        handlers,
        method: "approval.resolve",
        body: { id, kind, decision: "deny" },
        client: createClient({ deviceId: "reviewer" }),
      });
      expect(response.ok).toBe(true);
    }

    const firstPage = await invoke({
      handlers,
      method: "approval.history",
      body: { limit: 1 },
      client: createClient({ deviceId: "reviewer" }),
      context: createContext("/operator/"),
    });
    expect(firstPage.ok).toBe(true);
    expect(validateApprovalHistoryResult(firstPage.result)).toBe(true);
    const firstResult = firstPage.result as ApprovalHistoryResult;
    expect(firstResult.items).toHaveLength(1);
    expect(firstResult.items[0]).toMatchObject({
      status: "denied",
      decision: "deny",
      source: { agentId: "main", sessionKey: "agent:main:child" },
      resolver: { kind: "device", id: "reviewer" },
    });
    expect(firstResult.nextCursor).toEqual(expect.any(String));

    const secondPage = await invoke({
      handlers,
      method: "approval.history",
      body: { cursor: firstResult.nextCursor, limit: 1 },
      client: createClient({ deviceId: "reviewer" }),
    });
    expect(secondPage.ok).toBe(true);
    expect((secondPage.result as ApprovalHistoryResult).items).toHaveLength(1);
    expect((secondPage.result as ApprovalHistoryResult).nextCursor).toBeUndefined();
  });

  it("returns an exact-id, deep-linkable exec projection without execution bindings", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const id = "exec:approval.with_safe-punctuation";
    registerExec(managers.exec, {
      id,
      reviewerDeviceIds: ["reviewer-a"],
      request: {
        commandPreview: "printf approval-handler",
        warningText: "Review carefully",
        cwd: "/private/workspace",
        systemRunBinding: {
          argv: ["printf", "approval-handler"],
          cwd: "/private/workspace",
          agentId: "main",
          sessionKey: "agent:main:child",
          envHash: "private-env-binding",
        },
      },
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id },
      client: createClient({ deviceId: "reviewer-a" }),
      context: createContext("/operator/"),
    });
    expect(response.ok).toBe(true);
    expect(validateApprovalGetResult(response.result)).toBe(true);
    expect(approvalFromResult(response.result)).toMatchObject({
      id,
      status: "pending",
      urlPath: "/operator/approve/exec%3Aapproval.with_safe-punctuation",
      presentation: {
        kind: "exec",
        commandText: "printf approval-handler",
        warningText: "Review carefully",
        host: "gateway",
        agentId: "main",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain("/private/workspace");
    expect(serialized).not.toContain("private-env-binding");

    const prefix = await invoke({
      handlers,
      method: "approval.get",
      body: { id: "exec:approval" },
      client: createClient({ deviceId: "reviewer-a" }),
    });
    expect(prefix.ok).toBe(false);
    expect(prefix.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });
  });

  it("makes missing and unauthorized approval lookups indistinguishable", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    registerExec(managers.exec, { id: "authorization" });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const unauthorized = await invoke({
      handlers,
      method: "approval.get",
      body: { id: "authorization" },
      client: createClient({ scopes: ["operator.approvals"] }),
    });
    const missing = await invoke({
      handlers,
      method: "approval.get",
      body: { id: "missing" },
      client: createClient({ deviceId: "reviewer" }),
    });
    expect(unauthorized).toMatchObject({ ok: false, error: missing.error });

    const internal = await invoke({
      handlers,
      method: "approval.get",
      body: { id: "authorization" },
      client: createClient({ internal: true }),
    });
    expect(internal).toMatchObject({ ok: false, error: missing.error });

    const underscopedInternal = await invoke({
      handlers,
      method: "approval.get",
      body: { id: "authorization" },
      client: createClient({ internal: true, scopes: ["operator.read"] }),
    });
    expect(underscopedInternal).toMatchObject({ ok: false, error: missing.error });
  });

  it("enforces explicit reviewer bindings over requester ownership", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: "reviewer-bound-unified-approval",
      reviewerDeviceIds: ["reviewer-a"],
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    for (const deviceId of ["reviewer-b", "requester-device"]) {
      for (const method of ["approval.get", "approval.resolve"] as const) {
        const response = await invoke({
          handlers,
          method,
          body:
            method === "approval.get"
              ? { id: pending.record.id }
              : { id: pending.record.id, kind: "exec", decision: "deny" },
          client: createClient({ deviceId }),
        });
        expect(response).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
        });
      }
    }
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const winner = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-a" }),
    });
    expect(winner.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny" },
    });

    const hiddenTerminal = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer-b" }),
    });
    expect(hiddenTerminal).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
  });

  it("lets only the server-authenticated device-less runtime resolve", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "trusted-runtime-resolve" });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    const body = { id: pending.record.id, kind: "exec", decision: "deny" };

    const untrusted = await invoke({
      handlers,
      method: "approval.resolve",
      body,
      client: createClient({ scopes: ["operator.approvals"] }),
    });
    expect(untrusted).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const underscopedInternal = await invoke({
      handlers,
      method: "approval.resolve",
      body,
      client: createClient({ internal: true, scopes: ["operator.read"] }),
    });
    expect(underscopedInternal).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const trusted = await invoke({
      handlers,
      method: "approval.resolve",
      body,
      client: createClient({ internal: true }),
    });
    expect(trusted.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    expect(getOperatorApproval({ id: pending.record.id, databaseOptions })?.resolver).toEqual({
      kind: "runtime",
      id: "approval-test",
    });
    await expect(pending.decision).resolves.toBe("deny");
  });

  it.each([
    ["approval.get", String.fromCharCode(0xd800)],
    ["approval.resolve", String.fromCharCode(0xd800)],
    ["approval.get", "."],
    ["approval.resolve", ".."],
  ] as const)("rejects unsafe approval id through %s: %s", async (method, id) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-unsafe-approval-id-"));
    tempDirs.push(databasePath);
    const handlers = createApprovalHandlers({
      execApprovalManager: new ExecApprovalManager(),
      pluginApprovalManager: new ExecApprovalManager<PluginApprovalRequestPayload>(),
      databaseOptions: { path: databasePath },
    });

    const response = await invoke({
      handlers,
      method,
      body: {
        id,
        ...(method === "approval.resolve" ? { kind: "exec", decision: "deny" } : {}),
      },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.each(["approval.get", "approval.resolve"] as const)(
    "returns sanitized UNAVAILABLE when %s cannot read durable state",
    async (method) => {
      const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-broken-db-"));
      tempDirs.push(databasePath);
      const context = createContext();
      const handlers = createApprovalHandlers({
        execApprovalManager: new ExecApprovalManager(),
        pluginApprovalManager: new ExecApprovalManager<PluginApprovalRequestPayload>(),
        databaseOptions: { path: databasePath },
      });

      const response = await invoke({
        handlers,
        method,
        body:
          method === "approval.get"
            ? { id: "lookup" }
            : { id: "lookup", kind: "exec", decision: "deny" },
        client: createClient({ deviceId: "reviewer" }),
        context,
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "approval lookup unavailable" },
      });
      expect(JSON.stringify(response.error)).not.toContain(databasePath);
      expect(context.logGateway.error).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels only approvals owned by the aborted active run", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const aborted = registerExec(managers.exec, {
      id: "aborted-run-approval",
      request: { runId: "run-active", toolCallId: "tool-active" },
      reviewerDeviceIds: ["later-surface"],
    });
    const completedRun = registerExec(managers.exec, {
      id: "completed-run-approval",
      request: { runId: "run-completed", toolCallId: "tool-completed" },
    });
    const context = createContext();

    expect(
      cancelRunBoundExecApprovals({
        runId: "run-active",
        manager: managers.exec,
        context,
      }),
    ).toBe(1);

    await expect(aborted.decision).resolves.toBeNull();
    expect(managers.exec.getSnapshot(aborted.record.id)).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    const completedRunSnapshot = managers.exec.getSnapshot(completedRun.record.id);
    expect(completedRunSnapshot).toMatchObject({
      request: { runId: "run-completed" },
    });
    expect(completedRunSnapshot?.resolvedAtMs).toBeUndefined();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "exec.approval.resolved",
      expect.objectContaining({ id: aborted.record.id, decision: "deny" }),
      new Set(["approval-client"]),
      { dropIfSlow: true },
    );

    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    const replay = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: aborted.record.id, kind: "exec", decision: "allow-once" },
      client: createClient({ deviceId: "later-surface" }),
      context,
    });
    expect(replay.result).toMatchObject({
      applied: false,
      approval: {
        id: aborted.record.id,
        status: "cancelled",
        reason: "run-aborted",
      },
    });
  });

  it("keeps JSON Schema-sized astral plugin text visible", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const title = String.fromCodePoint(0x1f680).repeat(80);
    const description = String.fromCodePoint(0x1f6e1).repeat(512);
    const pending = registerPlugin(managers.plugin, {
      id: "plugin:unicode-boundaries",
      request: { title, description },
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response.ok).toBe(true);
    expect(validateApprovalGetResult(response.result)).toBe(true);
    expect(approvalFromResult(response.result)).toMatchObject({
      presentation: { kind: "plugin", title, description },
    });
  });

  it("resolves a durable deny without reconstructing a raw legacy request", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const id = "durable-deny-without-live-request";
    const nowMs = Date.now();
    insertOperatorApproval({
      approval: {
        id,
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "durable safe preview",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
      },
      databaseOptions,
    });
    const context = createContext();
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        presentation: { kind: "exec", commandText: "durable safe preview" },
      },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("expires durable state on a forward-clock lookup and settles the live waiter", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: "forward-clock-expiry",
      expiresAtMs: 2_000,
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    now.mockReturnValue(2_000);

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response.result).toMatchObject({
      approval: { status: "expired", reason: "timeout", resolvedAtMs: 2_000 },
    });
    expect(validateApprovalGetResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
  });

  it.each([
    ["missing", deleteDurableApproval],
    ["corrupt", corruptDurableApprovalPresentation],
  ] as const)("fails a live waiter closed when durable state is %s", async (_label, mutate) => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: `durable-${_label}` });
    mutate(databaseOptions, pending.record.id);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("settles the canonical live waiter when a transport-ref lookup finds corrupt state", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "corrupt-through-transport-ref" });
    const durable = getOperatorApproval({ id: pending.record.id, databaseOptions });
    if (!durable) {
      throw new Error("expected durable approval");
    }
    corruptDurableApprovalPresentation(databaseOptions, pending.record.id);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable.resolutionRef, kind: "exec", decision: "allow-once" },
      client: createClient({ deviceId: "telegram" }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("repairs durable pending state after a transient local storage failure", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-reconcile-"));
    tempDirs.push(stateDir);
    const databasePath = path.join(stateDir, "state.sqlite");
    const backupPath = path.join(stateDir, "state.backup.sqlite");
    const databaseOptions = { path: databasePath } satisfies OpenClawStateDatabaseOptions;
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "transient-storage-repair" });
    closeOpenClawStateDatabaseForTest();
    fs.renameSync(databasePath, backupPath);
    fs.mkdirSync(databasePath);
    expect(() =>
      managers.exec.resolveDetailed(
        pending.record.id,
        "deny",
        { kind: "device", id: "reviewer-device" },
        "Reviewer",
      ),
    ).toThrow();
    await expect(pending.decision).resolves.toBe("deny");
    fs.rmSync(databasePath, { recursive: true });
    fs.renameSync(backupPath, databasePath);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response.result).toMatchObject({
      approval: {
        status: "denied",
        decision: "deny",
        reason: "storage-corrupt",
      },
    });
    expect(getOperatorApproval({ id: pending.record.id, databaseOptions })).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("does not mutate a live waiter for an unauthorized durable lookup", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "unauthorized-missing-durable-row" });
    deleteDurableApproval(databaseOptions, pending.record.id);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "unrelated-device", scopes: ["operator.approvals"] }),
    });

    expect(response.ok).toBe(false);
    expect(managers.exec.getLiveSnapshot(pending.record.id)?.resolvedAtMs).toBeUndefined();
  });

  it("resolves plugin approvals through the durable CAS and publishes once", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerPlugin(managers.plugin, {
      id: "plugin:deny-is-always-valid",
      request: { allowedDecisions: ["allow-once"] },
      reviewerDeviceIds: ["phone-device"],
    });
    const context = createContext();
    const handlePluginApprovalResolved = vi.fn(async () => {});
    const handlePluginIosPushResolved = vi.fn(async () => {});
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved: vi.fn(async () => {}),
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved,
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      forwarder,
      pluginIosPushDelivery: { handleResolved: handlePluginIosPushResolved },
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "plugin", decision: "deny" },
      client: createClient({ deviceId: "phone-device" }),
      context,
    });
    expect(response.ok).toBe(true);
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        reason: "user",
        presentation: {
          kind: "plugin",
          title: "Plugin permission",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining({
        id: pending.record.id,
        decision: "deny",
        resolvedBy: "Approval Test",
      }),
      new Set(["approval-client"]),
      { dropIfSlow: true },
    );
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({
        id: pending.record.id,
        decision: "deny",
        resolvedBy: "Approval Test",
      }),
    );
    expect(getOperatorApproval({ id: pending.record.id, databaseOptions })?.resolver).toEqual({
      kind: "device",
      id: "phone-device",
    });
    expect(handlePluginApprovalResolved).toHaveBeenCalledTimes(1);
    expect(handlePluginIosPushResolved).toHaveBeenCalledTimes(1);
    expect(handlePluginIosPushResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
    const recipientLookup = context.getApprovalClientConnIds as ReturnType<typeof vi.fn>;
    const recipientOptions = recipientLookup.mock.calls[0]?.[0] as
      | {
          approvalKind?: string;
          filter?: (
            client: GatewayRequestHandlerOptions["client"],
            record?: { id: string },
          ) => boolean;
          record?: { id: string };
        }
      | undefined;
    expect(recipientOptions?.approvalKind).toBe("plugin");
    expect(
      recipientOptions?.filter?.(createClient({ deviceId: "unrelated" }), recipientOptions.record),
    ).toBe(false);
    expect(
      recipientOptions?.filter?.(
        createClient({ deviceId: "requester-device" }),
        recipientOptions.record,
      ),
    ).toBe(true);

    const terminal = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ scopes: ["operator.admin"] }),
    });
    expect(validateApprovalGetResult(terminal.result)).toBe(true);
    expect(approvalFromResult(terminal.result)).toMatchObject({
      status: "denied",
      decision: "deny",
    });
  });

  it("returns durable exec truth and continues follow-ups after publication failures", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "exec-publication-failures" });
    const context = createContext();
    const broadcastToConnIds = context.broadcastToConnIds as ReturnType<typeof vi.fn>;
    broadcastToConnIds.mockImplementation(() => {
      throw new Error("broadcast unavailable");
    });
    const handleResolved = vi.fn(async () => {
      throw new Error("forwarder unavailable");
    });
    const handleIosResolved = vi.fn(async () => {});
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved,
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      forwarder,
      iosPushDelivery: { handleResolved: handleIosResolved },
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("deny");
    expect(getOperatorApproval({ id: pending.record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
    });
    expect(handleResolved).toHaveBeenCalledTimes(1);
    expect(handleIosResolved).toHaveBeenCalledTimes(1);
    expect(context.logGateway.error).toHaveBeenCalledWith(
      expect.stringContaining("exec approvals: unified resolve broadcast failed"),
    );
    expect(context.logGateway.error).toHaveBeenCalledWith(
      expect.stringContaining("exec approvals: unified resolve forwarder failed"),
    );
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "exec",
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
  });

  it("responds with committed truth before a slow resolution forwarder finishes", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, { id: "exec-slow-resolution-forwarder" });
    let releaseForwarder!: () => void;
    const forwarderPending = new Promise<void>((resolve) => {
      releaseForwarder = resolve;
    });
    const handleResolved = vi.fn(() => forwarderPending);
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved,
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      forwarder,
      databaseOptions,
    });
    const respond = vi.fn();
    const handler = expectDefined(
      handlers["approval.resolve"],
      'handlers["approval.resolve"] test invariant',
    )({
      req: {
        id: "req-slow-forwarder",
        type: "req",
        method: "approval.resolve",
        params: { id: pending.record.id, kind: "exec", decision: "deny" },
      },
      params: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context: createContext(),
      isWebchatConnect: () => false,
      respond,
    });
    let handlerFinished = false;
    const handlerCompletion = Promise.resolve(handler).then(() => {
      handlerFinished = true;
    });

    try {
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1), { timeout: 500 });
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        applied: true,
        approval: { status: "denied", decision: "deny" },
      });
      await vi.waitFor(() => expect(handleResolved).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(handlerFinished).toBe(true), { timeout: 500 });
    } finally {
      releaseForwarder();
    }
    await handlerCompletion;
  });

  it("continues plugin forwarding when the resolved-event broadcast fails", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerPlugin(managers.plugin, { id: "plugin-publication-failure" });
    const context = createContext();
    const broadcastToConnIds = context.broadcastToConnIds as ReturnType<typeof vi.fn>;
    broadcastToConnIds.mockImplementation(() => {
      throw new Error("broadcast unavailable");
    });
    const handlePluginApprovalResolved = vi.fn(async () => {});
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved: vi.fn(async () => {}),
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved,
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      forwarder,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "plugin", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny" },
    });
    expect(handlePluginApprovalResolved).toHaveBeenCalledTimes(1);
    expect(context.logGateway.error).toHaveBeenCalledWith(
      expect.stringContaining("plugin approvals: unified resolve broadcast failed"),
    );
  });

  it("uses the live requester connection when filtering legacy resolved events", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: "device-less-requester",
      reviewerDeviceIds: ["reviewer-device"],
      requester: {
        connId: "requester-connection",
        deviceId: null,
        clientId: "requester-client",
      },
    });
    const context = createContext();
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-device" }),
      context,
    });

    expect(response.result).toMatchObject({ applied: true, approval: { status: "denied" } });
    const recipientLookup = context.getApprovalClientConnIds as ReturnType<typeof vi.fn>;
    const recipientOptions = recipientLookup.mock.calls[0]?.[0] as
      | {
          approvalKind?: string;
          filter?: (
            client: GatewayRequestHandlerOptions["client"],
            record?: { requestedByConnId?: string | null },
          ) => boolean;
          record?: { requestedByConnId?: string | null };
        }
      | undefined;
    expect(recipientOptions?.approvalKind).toBe("exec");
    expect(recipientOptions?.record?.requestedByConnId).toBe("requester-connection");
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "requester-connection" }),
        recipientOptions.record,
      ),
    ).toBe(true);
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "unrelated-connection" }),
        recipientOptions.record,
      ),
    ).toBe(false);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("returns the recorded winner to a competing surface without rebroadcasting", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: "first-answer-wins",
      reviewerDeviceIds: ["control-ui", "telegram"],
    });
    const context = createContext();
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const [first, second] = await Promise.all([
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "allow-once" },
        client: createClient({ deviceId: "control-ui" }),
        context,
      }),
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "deny" },
        client: createClient({ deviceId: "telegram" }),
        context,
      }),
    ]);
    expect([first.result, second.result]).toEqual([
      expect.objectContaining({
        applied: true,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
      expect.objectContaining({
        applied: false,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
    ]);
    expect(validateApprovalResolveResult(first.result)).toBe(true);
    expect(validateApprovalResolveResult(second.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("resolves a maximum-length canonical id through its fixed-size transport reference", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: `approval-${"a".repeat(119)}`,
      reviewerDeviceIds: ["telegram"],
    });
    const durable = getOperatorApproval({ id: pending.record.id, databaseOptions });
    expect(durable?.resolutionRef).toHaveLength(43);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable?.resolutionRef, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "telegram" }),
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("deny");
  });

  it("resolves through the durable transport ref exactly like the canonical id", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    // No explicit reviewer binding: any authorized reviewer device may resolve,
    // and the opaque transport ref must behave exactly like the canonical id.
    const pending = registerExec(managers.exec, {
      id: "ref-parity-approval",
      requester: { connId: "conn-owner", deviceId: null, clientId: null },
      reviewerDeviceIds: [],
    });
    const durable = getOperatorApproval({ id: pending.record.id, databaseOptions });
    expect(durable?.resolutionRef).toHaveLength(43);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const winner = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable?.resolutionRef, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-surface" }),
    });
    expect(winner.result).toMatchObject({
      applied: true,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
    await expect(pending.decision).resolves.toBe("deny");

    const replayByCanonicalId = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "another-surface" }),
    });
    expect(replayByCanonicalId.result).toMatchObject({
      applied: false,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
  });
  it.each([
    { status: "allowed", decision: "allow-once", terminalDecision: "allow-once" },
    { status: "denied", decision: "deny", terminalDecision: "deny" },
    { status: "expired", decision: "allow-once", terminalDecision: null },
    { status: "cancelled", decision: "allow-once", terminalDecision: null },
  ] as const)(
    "returns retained $status truth after the process-local waiter is gone",
    async ({ status, decision, terminalDecision }) => {
      const databaseOptions = createDatabaseOptions();
      const managers = createManagers(databaseOptions);
      const pending = registerExec(managers.exec, {
        id: `terminal-after-restart-${status}`,
        reviewerDeviceIds: ["later-surface"],
      });
      if (status === "allowed" || status === "denied") {
        managers.exec.resolveDetailed(pending.record.id, terminalDecision, {
          kind: "device",
          id: "first-surface",
        });
      } else {
        managers.exec.forceDenyDetailed(
          pending.record.id,
          status === "expired" ? "timeout" : "run-aborted",
          { kind: "system", id: null },
          status,
          null,
        );
      }
      await expect(pending.decision).resolves.toBe(terminalDecision);

      const restartedManagers = createManagers(databaseOptions);
      const context = createContext();
      const handlers = createApprovalHandlers({
        execApprovalManager: restartedManagers.exec,
        pluginApprovalManager: restartedManagers.plugin,
        databaseOptions,
      });
      const response = await invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision },
        client: createClient({ deviceId: "later-surface" }),
        context,
      });

      expect(response.result).toMatchObject({
        applied: false,
        approval: {
          status,
        },
      });
      expect(validateApprovalResolveResult(response.result)).toBe(true);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("atomically denies malformed, mismatched-kind, and disallowed approving verdicts", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const disallowed = registerExec(managers.exec, {
      id: "disallowed-allow-always",
      request: { unavailableDecisions: ["allow-always"] },
    });
    const malformed = registerPlugin(managers.plugin, {
      id: "plugin:malformed",
      request: { allowedDecisions: ["allow-once"] },
    });
    const mismatchedKind = registerPlugin(managers.plugin, {
      id: "opaque-plugin-id",
      request: { allowedDecisions: ["allow-once"] },
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    const client = createClient({ deviceId: "reviewer" });

    const disallowedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: disallowed.record.id, kind: "exec", decision: "allow-always" },
      client,
    });
    expect(disallowedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(disallowed.decision).resolves.toBe("deny");

    const malformedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: malformed.record.id, kind: "plugin", decision: "ACCEPT" },
      client,
    });
    expect(malformedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(malformed.decision).resolves.toBe("deny");

    const mismatchedKindResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: mismatchedKind.record.id, kind: "exec", decision: "allow-once" },
      client,
    });
    expect(mismatchedKindResponse.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        reason: "malformed-verdict",
        presentation: { kind: "plugin" },
      },
    });
    await expect(mismatchedKind.decision).resolves.toBe("deny");
  });

  it("lets the exact deadline beat a malformed verdict", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = registerExec(managers.exec, {
      id: "malformed-at-deadline",
      expiresAtMs: 2_000,
    });
    const context = createContext();
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });
    // The lookup observes pending immediately before the deadline; force-deny's
    // store transaction reaches the exact deadline and must reconcile expiry.
    now.mockReturnValueOnce(1_999).mockReturnValue(2_000);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "ACCEPT" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: false,
      approval: {
        status: "expired",
        reason: "timeout",
        resolvedAtMs: 2_000,
      },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
