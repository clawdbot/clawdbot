import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureExecutionDecisionWorkSink,
  type ExecutionDecisionWork,
} from "../../audit/execution-decision-work.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  isAgentSessionModelPatchOrigin,
  snapshotAgentModelFallback,
} from "../../gateway/session-model-patch-origin.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  expectExactResolvedAcknowledgement,
} from "./sessions-tool.test-helpers.js";

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

function withModelOverride(params: Parameters<typeof applyModelOverrideToSessionEntry>[0]) {
  applyModelOverrideToSessionEntry({ ...params, markLiveSwitchPending: true });
  return params.entry;
}

async function captureSessionDecisionWork<T>(run: () => Promise<T>): Promise<{
  result: T;
  work: ExecutionDecisionWork[];
}> {
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const token = createExecutionIdentityAdmissionToken("sessions-tool-action", {
      contextId: "sessions-tool-context",
      executionId: "sessions-tool-execution",
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        executionIdentityToken: token,
        receiptAuthority: () => true,
      },
      run,
    );
    return { result, work };
  } finally {
    clear();
  }
}

describe("sessions tool", () => {
  it("carries the persisted fixed-store owner for a bare patch key", async () => {
    const callGateway = vi.fn().mockResolvedValue({});
    const tool = createSessionsTool({
      agentSessionKey: "global",
      config: {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
      callGateway,
    });

    await tool.execute("owned-patch", { action: "patch", label: "Ops" });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: { key: "global", agentId: "ops", label: "Ops" },
    });
  });

  it("resolves current under the requester instead of the persisted bare-row owner", async () => {
    const requests: AgentToolGatewayRequest[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: AgentToolGatewayRequest,
    ) => {
      requests.push(request);
      return { ok: true } as T;
    };
    const tool = createSessionsTool({
      agentSessionKey: "agent:research:main",
      requesterAgentIdOverride: "research",
      config: {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
      callGateway,
    });

    await tool.execute("research-current", {
      action: "patch",
      sessionKey: "current",
      label: "Research",
    });

    expect(requests).toContainEqual({
      method: "sessions.patch",
      params: { key: "agent:research:main", label: "Research" },
    });
    expect(requests.some((request) => request.method === "sessions.resolve")).toBe(false);
  });

  it.each(["patch", "reset", "delete"] as const)(
    "does not treat another agent's bare global row as self for %s",
    async (action) => {
      const requests: AgentToolGatewayRequest[] = [];
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: AgentToolGatewayRequest,
      ) => {
        requests.push(request);
        if (request.method === "sessions.resolve") {
          return { agentId: "ops", key: "global" } as T;
        }
        throw new Error(`unexpected gateway mutation: ${request.method}`);
      };
      const tool = createSessionsTool({
        agentSessionKey: "global",
        requesterAgentIdOverride: "research",
        config: {
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        },
        callGateway,
      });

      await expect(
        tool.execute(`foreign-global-${action}`, {
          action,
          sessionKey: "2fb701ef-6425-4c48-9b6f-5a170aa2477e",
          ...(action === "patch" ? { label: "Ops" } : {}),
        }),
      ).rejects.toThrow("Session status visibility is restricted");
      expect(requests).toContainEqual(expect.objectContaining({ method: "sessions.resolve" }));
      expect(
        requests.some((request) =>
          ["sessions.patch", "sessions.reset", "sessions.delete"].includes(request.method),
        ),
      ).toBe(false);
    },
  );

  it("cannot patch an incognito session through the cross-session tool", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: sessionKey,
      config: {},
      callGateway,
    });

    await expect(
      tool.execute("incognito-patch", { action: "patch", label: "private" }),
    ).rejects.toThrow("Session not visible from session tools");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("advertises the full model-visible sidebar presence contract", () => {
    const tool = createSessionsTool({ agentSessionKey: "agent:main:main", callGateway: vi.fn() });
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "patch",
            "reset",
            "delete",
            "assign_owner",
            "group_list",
            "group_set",
            "group_rename",
            "group_delete",
          ],
        },
        deleteTranscript: { type: "boolean" },
        label: { type: "string", description: expect.stringContaining("Empty string clears") },
        icon: {
          type: "string",
          description: expect.stringContaining(
            "named icon: braces, book, monitor, bot, kanban, coins",
          ),
        },
        group: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: expect.stringContaining("creates the group"),
        },
        statusNote: { type: "string", maxLength: 120 },
        attention: {
          type: "string",
          enum: ["clear", "hand", "key", "alert", "flag", "lock", "hourglass"],
        },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 120 },
        archived: { type: "boolean", description: expect.stringContaining("without deleting") },
      },
    });
    expect(tool.parameters).not.toHaveProperty("properties.message");
  });

  it("does not expose direct session creation outside controlled spawning", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(tool.execute("create-uncontrolled-session", { action: "create" })).rejects.toThrow(
      "Unknown action: create",
    );
    expect(tool.parameters).not.toHaveProperty("properties.parentSessionKey");
    expect(tool.parameters).not.toHaveProperty("properties.agentId");
    expect(tool.parameters).not.toHaveProperty("properties.fork");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("assigns a visible session owner and returns the projected identity", async () => {
    const callGateway = vi.fn(async (request: { method: string }) => {
      if (request.method !== "sessions.assignOwner") {
        throw new Error(`unexpected method: ${request.method}`);
      }
      return {
        ok: true,
        key: "agent:main:main",
        owner: {
          actor: { type: "human", id: "profile-colin", label: "Colin" },
          assignedBy: { type: "agent", id: "main" },
          assignedAt: 10,
        },
      };
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: callGateway as never,
    });

    const result = await tool.execute("assign-colin", {
      action: "assign_owner",
      ownerType: "human",
      ownerId: "profile-colin",
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.assignOwner",
      params: {
        key: "agent:main:main",
        owner: { type: "human", id: "profile-colin" },
      },
      agentToolCaller: { agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining('"label": "Colin"'),
        },
      ],
    });
  });

  it("archives a visible target before write-scoped session deletion", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const lifecycleRevision = "finished-revision";
    const callGateway = vi.fn(async (request: { method: string }) =>
      request.method === "sessions.patch"
        ? { ok: true, entry: { sessionId, lifecycleRevision } }
        : { ok: true, deleted: true },
    );
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    const { work } = await captureSessionDecisionWork(
      async () =>
        await tool.execute("delete-session", {
          action: "delete",
          sessionKey,
          expectedSessionId: sessionId,
        }),
    );

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
        },
      ],
      [
        {
          method: "sessions.delete",
          params: {
            key: sessionKey,
            archivedOnly: true,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: lifecycleRevision,
            deleteTranscript: true,
          },
        },
      ],
    ]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      receipt: {
        action: { family: "session", operation: "delete" },
        decision: { outcome: "allowed", reasonCode: "session_delete_committed" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: { target: { namespace: "session", value: `["main","${sessionKey}"]` } },
    });
  });

  it("does not discover a lifecycle identity while deleting another session", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway,
    });

    await expect(
      tool.execute("delete-without-identity", {
        action: "delete",
        sessionKey: "agent:main:dashboard:finished",
      }),
    ).rejects.toThrow("requires a durable session identity");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("forwards an explicit transcript-preservation choice on deletion", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const callGateway = vi.fn(async (request: { method: string }) =>
      request.method === "sessions.patch"
        ? { ok: true, entry: { sessionId } }
        : { ok: true, deleted: false },
    );
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    const { work } = await captureSessionDecisionWork(
      async () =>
        await tool.execute("delete-preserve", {
          action: "delete",
          sessionKey,
          expectedSessionId: sessionId,
          deleteTranscript: false,
        }),
    );

    expect(callGateway).toHaveBeenLastCalledWith({
      method: "sessions.delete",
      params: {
        key: sessionKey,
        archivedOnly: true,
        expectedSessionId: sessionId,
        deleteTranscript: false,
      },
    });
    expect(work[0]?.receipt).toMatchObject({
      decision: { outcome: "allowed", reasonCode: "session_delete_committed" },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it("does not delete a session when archive cannot identify its generation", async () => {
    const sessionKey = "agent:main:dashboard:finished";
    const sessionId = "finished-session";
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    await expect(
      tool.execute("delete-missing-generation", {
        action: "delete",
        sessionKey,
        expectedSessionId: sessionId,
      }),
    ).rejects.toThrow("archive did not return its session identity");

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        archived: true,
        expectedSessionId: sessionId,
      },
    });
  });

  it("resets another visible session through the canonical gateway method", async () => {
    const sessionKey = "agent:main:dashboard:reset-me";
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway: callGateway as never,
    });

    const { work } = await captureSessionDecisionWork(
      async () => await tool.execute("reset-session", { action: "reset", sessionKey }),
    );

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.reset",
      params: {
        key: sessionKey,
        reason: "reset",
      },
    });
    expect(work[0]?.receipt).toMatchObject({
      action: { family: "session", operation: "reset" },
      decision: { outcome: "allowed", reasonCode: "session_reset_committed" },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it("records a typed lifecycle conflict without classifying error prose", async () => {
    const sessionKey = "agent:main:dashboard:changed";
    const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "arbitrary presentation text",
        retryable: false,
        details: { reason: "session-changed" },
      });
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway,
    });

    const { work } = await captureSessionDecisionWork(async () => {
      await expect(tool.execute("reset-changed", { action: "reset", sessionKey })).rejects.toThrow(
        "arbitrary presentation text",
      );
    });

    expect(work[0]?.receipt).toMatchObject({
      decision: { outcome: "denied", reasonCode: "session_reset_conflict" },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it.each([
    { operation: "patch", args: { label: "Updated" } },
    { operation: "archive", args: { archived: true } },
    { operation: "restore", args: { archived: false } },
  ] as const)("records a committed $operation result", async ({ operation, args }) => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: "/tmp/sessions.sqlite",
      key: "agent:main:main",
      entry: { sessionId: "session-main" },
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
    });

    const { work } = await captureSessionDecisionWork(
      async () => await tool.execute(`committed-${operation}`, { action: "patch", ...args }),
    );

    expect(work).toHaveLength(1);
    expect(work[0]?.receipt).toMatchObject({
      action: { family: "session", operation },
      decision: { outcome: "allowed", reasonCode: `session_${operation}_committed` },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it.each([
    { operation: "patch", args: { label: "Updated" } },
    { operation: "archive", args: { archived: true } },
    { operation: "restore", args: { archived: false } },
  ] as const)("records a typed $operation conflict", async ({ operation, args }) => {
    const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "arbitrary presentation text",
        retryable: false,
        details: { reason: "session-changed" },
      });
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
      callGateway,
    });

    const { work } = await captureSessionDecisionWork(async () => {
      await expect(
        tool.execute(`conflict-${operation}`, { action: "patch", ...args }),
      ).rejects.toThrow("arbitrary presentation text");
    });

    expect(work).toHaveLength(1);
    expect(work[0]?.receipt).toMatchObject({
      action: { family: "session", operation },
      decision: { outcome: "denied", reasonCode: `session_${operation}_conflict` },
      enforcement: { coverageState: "attribution-only" },
    });
  });

  it("drops a session result when receipt authority closes across its awaited RPC", async () => {
    const work: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((item) => {
      work.push(item);
      return true;
    });
    const token = createExecutionIdentityAdmissionToken("sessions-tool-closed", {
      contextId: "sessions-tool-closed-context",
      executionId: "sessions-tool-closed-execution",
    });
    let authorityActive = true;
    gatewayMocks.callGateway.mockImplementation(async () => {
      authorityActive = false;
      return {
        ok: true,
        path: "/tmp/sessions.sqlite",
        key: "agent:main:main",
        entry: { sessionId: "session-main" },
      };
    });
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          executionIdentityToken: token,
          receiptAuthority: () => authorityActive,
        },
        async () => await tool.execute("closed-patch", { action: "patch", label: "Updated" }),
      );
      expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
      expect(work).toEqual([]);
    } finally {
      clear();
    }
  });

  it.each(["delete", "reset"])("refuses to %s its currently running session", async (action) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(
      tool.execute(`self-${action}`, { action, sessionKey: "agent:main:main" }),
    ).rejects.toThrow(`Cannot ${action} the session running this tool`);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("patches its session, then reverts a failed agent-selected model", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { defaults: { model: { primary: "openai/good" } } },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "good",
          modelProvider: "openai",
          modelOverride: "good",
          providerOverride: "openai",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "primary",
          authProfileOverride: "good-profile",
          authProfileOverrideSource: "user",
          thinkingLevel: "high",
        },
      );
      const callGateway = vi.fn(
        async (request: { method: string; params: Record<string, unknown> }) => {
          expect(request.method).toBe("sessions.patch");
          expect(isAgentSessionModelPatchOrigin()).toBe(true);
          await patchSessionEntryCore(
            { agentId: "main", sessionKey, storePath },
            (entry) => {
              const modelFallback = snapshotAgentModelFallback(cfg, entry, "main", Date.now());
              return {
                ...withModelOverride({
                  entry,
                  selection: { provider: "broken", model: "bad" },
                  profileOverride: "bad-profile",
                }),
                label: request.params.label as string,
                thinkingLevel: "low",
                modelFallback,
              };
            },
            { replaceEntry: true },
          );
          return { ok: true };
        },
      );
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        config: cfg,
        callGateway: callGateway as never,
      });
      const currentRunGuard = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });

      await tool.execute("patch-model", {
        action: "patch",
        label: "Research",
        model: "broken/bad",
      });

      expect(callGateway).toHaveBeenCalledWith({
        method: "sessions.patch",
        params: {
          key: sessionKey,
          label: "Research",
          model: "broken/bad",
        },
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        label: "Research",
        modelFallback: {
          prevModel: "good",
          prevProvider: "openai",
          prevModelOverrideSource: "auto",
          prevModelOverrideFallbackOriginProvider: "openai",
          prevModelOverrideFallbackOriginModel: "primary",
          prevAuthProfileOverride: "good-profile",
          prevThinkingLevel: "high",
          source: "agent-patch",
        },
      });
      await currentRunGuard.finish(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toHaveProperty(
        "modelFallback",
      );

      const runGuard = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await runGuard.fail({ status: 404, message: "No endpoints found for broken/bad." });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "good",
        modelProvider: "openai",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "primary",
        authProfileOverride: "good-profile",
        thinkingLevel: "high",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-main",
        sessionKey,
        storePath,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            customType: "openclaw.system-note",
            content: "System note: model broken/bad failed; reverted to openai/good.",
          }),
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            customType: "openclaw.system-note",
            excludeFromContext: expect.anything(),
          }),
        }),
      );
    });
  });

  it("clears the model fallback marker after a successful run", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-success-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        withModelOverride({
          entry: {
            sessionId: "session-main",
            updatedAt: 1,
            modelFallback: {
              prevModel: "good",
              prevProvider: "openai",
              ts: 1,
              source: "agent-patch",
            },
          },
          selection: { provider: "openai", model: "better" },
        }),
      );

      await createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      }).finish(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });

  it("denies model patches without in-process gateway context", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
      hasInProcessGatewayContext: () => false,
    });

    const result = await tool.execute("patch-model", {
      action: "patch",
      model: "openai/gpt-5.4",
    });

    expect(result.details).toEqual({
      status: "forbidden",
      error: "Model patch needs in-process gateway.",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reverts when the patched model fails but a fallback completes the run", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-fallback-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        withModelOverride({
          entry: {
            sessionId: "session-main",
            updatedAt: 1,
            modelFallback: {
              prevModel: "good",
              prevProvider: "openai",
              ts: 1,
              source: "agent-patch",
            },
          },
          selection: { provider: "broken", model: "bad" },
        }),
      );
      const runGuard = createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      });

      const needsRevert = runGuard.captureFallbackFailure([
        {
          error: "No endpoints found for broken/bad.",
          reason: "model_not_found",
        },
        { error: "Fallback context overflow.", reason: "context_overflow" },
      ]);
      await runGuard.finish(!needsRevert);

      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "good",
        modelProvider: "openai",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });

  it("promotes the newest validated model across overlapping patches", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-overlap-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/a" } } },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        withModelOverride({
          entry: {
            sessionId: "session-main",
            updatedAt: 1,
            modelFallback: {
              prevModel: "a",
              prevProvider: "openai",
              ts: 10,
              source: "agent-patch",
            },
          },
          selection: { provider: "openai", model: "b" },
        }),
      );
      const runB = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        (entry) => ({
          ...withModelOverride({ entry, selection: { provider: "openai", model: "c" } }),
          modelFallback: { ...entry.modelFallback!, ts: 20 },
        }),
        { replaceEntry: true },
      );
      const runC = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        (entry) => ({
          ...withModelOverride({ entry, selection: { provider: "openai", model: "d" } }),
          modelFallback: { ...entry.modelFallback!, ts: 30 },
        }),
        { replaceEntry: true },
      );
      const runD = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });

      await runC.finish(true);
      await runB.finish(true);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.modelFallback,
      ).toMatchObject({
        prevModel: "c",
        prevProvider: "openai",
        lastValidatedPatchTs: 20,
        ts: 30,
      });

      await runD.fail({ status: 404, message: "No endpoints found for openai/d." });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        model: "c",
        modelProvider: "openai",
        modelOverride: "c",
        providerOverride: "openai",
      });
    });
  });

  it("keeps resolved model and thinking metadata when self-archive is deferred", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-archive-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:subagent:archive-me";
      const sessionId = "archive-me-session";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      const callGateway = vi.fn(async () => ({
        ok: true as const,
        path: storePath,
        key: sessionKey,
        entry: { skillsSnapshot: "s".repeat(47_469) },
        resolved: adversarialResolved,
      }));
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway: callGateway as never,
      });
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });

      try {
        const { result, work } = await captureSessionDecisionWork(
          async () =>
            await admission.run(
              async () =>
                await tool.execute("patch-model-thinking-archive", {
                  action: "patch",
                  archived: true,
                  model: "openai/luna",
                  thinkingLevel: "med",
                }),
            ),
        );
        expect(result.details).toEqual({
          status: "scheduled",
          sessionKey,
          message: "Session will be archived after the current agent run finishes.",
          resolved: adversarialResolved,
        });
        expectExactResolvedAcknowledgement(result, adversarialResolved);
        expect(callGateway).toHaveBeenCalledTimes(1);
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({
          receipt: {
            action: { family: "session", operation: "archive" },
            decision: { outcome: "allowed", reasonCode: "session_archive_scheduled" },
            enforcement: { coverageState: "attribution-only" },
          },
          refs: { target: { namespace: "session", value: `["main","${sessionKey}"]` } },
        });
      } finally {
        admission.release();
      }

      await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(2));
      expect(callGateway).toHaveBeenNthCalledWith(1, {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          model: "openai/luna",
          thinkingLevel: "med",
          expectedSessionId: sessionId,
        },
      });
      expect(callGateway).toHaveBeenNthCalledWith(2, {
        method: "sessions.patch",
        params: {
          key: sessionKey,
          archived: true,
          expectedSessionId: sessionId,
        },
      });
    });
  });

  it("rejects an empty patch", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway,
    });

    await expect(tool.execute("patch-empty", { action: "patch" })).rejects.toThrow(
      "Patch setting required",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("denies patch targets outside a non-main caller's session tree", async () => {
    const callGateway = vi.fn(async () => ({ sessions: [] }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:dashboard:caller",
      callGateway: callGateway as never,
    });

    await expect(
      tool.execute("patch-other", {
        action: "patch",
        sessionKey: "agent:main:other",
        group: "Private",
        expectedSessionId: "other-session",
        archived: true,
      }),
    ).rejects.toThrow("Session status visibility is restricted");
    expect(callGateway).not.toHaveBeenCalledWith({
      method: "sessions.patch",
      params: expect.objectContaining({ key: "agent:main:other" }),
    });
  });
});
