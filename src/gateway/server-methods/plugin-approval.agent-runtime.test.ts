import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("plugin-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function executionIdentity() {
  return {
    tokenVersion: 1 as const,
    createdAt: 1,
    runId: "run-1",
    contextId: "context-1",
    executionId: "execution-1",
  };
}

function identityWithoutExecution(): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-run-1", runId: "run-1" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
  };
}

function requestOptions(params: {
  request: Record<string, unknown>;
  identity: AgentRuntimeIdentity;
  validateAuthority?: () => boolean;
}): GatewayRequestHandlerOptions {
  return {
    req: { method: "plugin.approval.request", params: params.request, id: "req-1" },
    params: params.request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: params.identity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: params.validateAuthority ?? (() => true),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function requestHandler(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
): NonNullable<ReturnType<typeof createPluginApprovalHandlers>["plugin.approval.request"]> {
  const handler = createPluginApprovalHandlers(manager)["plugin.approval.request"];
  if (!handler) {
    throw new Error("plugin approval request handler is unavailable");
  }
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("plugin approval signed agent runtime", () => {
  it("rejects closed authority before creating a plugin approval", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const opts = requestOptions({
      request: { title: "Sensitive action", description: "D" },
      identity: {
        ...identityWithoutExecution(),
        approvalOwnerPluginId: "codex",
      },
      validateAuthority: () => false,
    });

    await requestHandler(manager)(opts);

    expect(manager.listPendingRecords()).toHaveLength(0);
    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("no longer active"),
    });
  });

  it("cancels a plugin approval when authority closes after the handshake", async () => {
    let active = true;
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const opts = requestOptions({
      request: { title: "Sensitive action", description: "D", twoPhase: true },
      identity: {
        ...identityWithoutExecution(),
        approvalOwnerPluginId: "codex",
      },
      validateAuthority: () => active,
    });
    const pending = requestHandler(manager)(opts);
    await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
    const record = manager.listPendingRecords()[0]!;
    active = false;

    await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
    await pending;
    expect(manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
  });

  it("rejects a signed runtime without a host-resolved approval owner", async () => {
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const opts = requestOptions({
      request: { pluginId: "forged", title: "Sensitive action", description: "D" },
      identity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
        },
      },
    });

    await requestHandler(manager)(opts);

    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("signed plugin approval owner is unavailable"),
    });
  });

  it("uses signed runtime owner and route instead of forged request metadata", async () => {
    const options = databaseOptions();
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const opts = requestOptions({
      request: {
        pluginId: "forged-plugin",
        title: "Sensitive action",
        description: "D",
        agentId: "forged-agent",
        sessionKey: "forged-session",
        turnSourceChannel: "forged-channel",
        turnSourceTo: "forged-target",
        twoPhase: true,
      },
      identity: {
        kind: "agentRuntime",
        operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
        },
        executionIdentity: executionIdentity(),
        approvalOwnerPluginId: "codex",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      },
    });

    const pending = requestHandler(manager)(opts);
    await vi.waitFor(() => expect(opts.context.broadcast).toHaveBeenCalled());
    const broadcastPayload = vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as
      | { id?: unknown }
      | undefined;
    const approvalId = String(broadcastPayload?.id);
    expect(manager.getSnapshot(approvalId)?.request).toMatchObject({
      pluginId: "codex",
      agentId: "main",
      sessionKey: "agent:main:session-1",
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-1",
      turnSourceAccountId: "default",
      turnSourceThreadId: "thread-1",
    });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
        )
        .get(approvalId),
    ).toEqual({
      approval_id: approvalId,
      source_context_id: "context-1",
      source_execution_id: "execution-1",
    });
    manager.resolve(approvalId, "deny");
    await pending;
  });

  it("does not create execution identity storage when collection is disabled", async () => {
    const options = databaseOptions();
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const opts = requestOptions({
      request: { title: "Sensitive action", description: "D", twoPhase: true },
      identity: {
        kind: "agentRuntime",
        operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
        },
        approvalOwnerPluginId: "codex",
        agentId: "main",
        sessionKey: "agent:main:session-1",
      },
    });

    const pending = requestHandler(manager)(opts);
    await vi.waitFor(() => expect(opts.context.broadcast).toHaveBeenCalled());
    const approvalId = String(
      (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
    );
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
        )
        .get(),
    ).toBeUndefined();
    manager.resolve(approvalId, "deny");
    await pending;
  });
});
