import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/command-analysis/explain.js", () => ({
  resolveCommandAnalysisSummaryForDisplay: vi.fn(async () => null),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("exec-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function identity(enabled: boolean): AgentRuntimeIdentity {
  return {
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
    turnSourceChannel: "telegram",
    turnSourceTo: "chat-1",
    turnSourceAccountId: "default",
    turnSourceThreadId: "thread-1",
    ...(enabled
      ? {
          executionIdentity: {
            tokenVersion: 1,
            createdAt: 1,
            runId: "run-1",
            contextId: "context-1",
            executionId: "execution-1",
          },
        }
      : {}),
  };
}

function requestOptions(
  runtimeIdentity: AgentRuntimeIdentity,
  validateAuthority: () => boolean = () => true,
): GatewayRequestHandlerOptions {
  const request = {
    command: "echo ok",
    cwd: "/tmp",
    agentId: "forged-agent",
    sessionKey: "forged-session",
    sessionId: "forged-session-id",
    runId: "forged-run",
    turnSourceChannel: "forged-channel",
    turnSourceTo: "forged-target",
    turnSourceAccountId: "forged-account",
    turnSourceThreadId: "forged-thread",
    timeoutMs: 2_000,
    twoPhase: true,
  };
  return {
    req: { method: "exec.approval.request", params: request, id: "req-1" },
    params: request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: runtimeIdentity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({}),
      hasExecApprovalClients: () => true,
      chatRunState: createChatRunState(),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("exec approval signed agent runtime", () => {
  it("rejects closed authority before creating an exec approval", async () => {
    const manager = new ExecApprovalManager({
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false), () => false);

    await handler(opts);

    expect(manager.listPendingRecords()).toHaveLength(0);
    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("no longer active"),
    });
  });

  it("sanitizes display-only cwd and resolvedPath in the stored request", async () => {
    const manager = new ExecApprovalManager({
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false));
    // Bidi override in cwd/resolvedPath can spoof what path reviewers see.
    (opts.params as Record<string, unknown>).cwd = "/tmp/safe‮evil";
    (opts.params as Record<string, unknown>).resolvedPath = "/usr/bin/echo​x";
    // Free-form policy strings must not reach reviewer meta rows: security/ask
    // are closed enums (arbitrary values null out), host is escape-hardened.
    (opts.params as Record<string, unknown>).security = "full‮looks-deny";
    (opts.params as Record<string, unknown>).ask = "always​ish";
    const pending = handler(opts);
    await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
    const record = manager.listPendingRecords()[0]!;
    expect(record.request.cwd).toBe("/tmp/safe\\u{202E}evil");
    expect(record.request.resolvedPath).toBe("/usr/bin/echo\\u{200B}x");
    expect(record.request.security).toBeNull();
    expect(record.request.ask).toBeNull();
    manager.resolve(record.id, "deny");
    await pending;
  });

  it("cancels an exec approval when authority closes after the handshake", async () => {
    let active = true;
    const manager = new ExecApprovalManager({
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false), () => active);
    const pending = handler(opts);
    await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
    const record = manager.listPendingRecords()[0]!;
    active = false;

    await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
    await pending;
    expect(manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
  });

  it.each([
    ["enabled", true],
    ["disabled", false],
  ] as const)("uses signed runtime provenance with collection %s", async (_label, enabled) => {
    const options = databaseOptions();
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"];
    if (!handler) {
      throw new Error("exec approval request handler is unavailable");
    }
    const opts = requestOptions(identity(enabled));

    const pending = handler(opts);
    await vi.waitFor(() => expect(opts.context.broadcast).toHaveBeenCalled());
    const approvalId = String(
      (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
    );
    expect(manager.getSnapshot(approvalId)?.request).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: null,
      runId: "run-1",
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-1",
      turnSourceAccountId: "default",
      turnSourceThreadId: "thread-1",
    });
    const db = openOpenClawStateDatabase(options).db;
    if (enabled) {
      expect(
        db
          .prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
    } else {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
    }
    manager.resolve(approvalId, "deny");
    await pending;
  });
});
