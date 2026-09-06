import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

const APPROVER_ID = "11111111-2222-4333-8444-555555555555";
const UNAUTHORIZED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONVERSATION_ID = "19:approval-chat";
const ACTIVITY_ID = "card-activity";
const testTokens = new Set<string>();

function createResolution(params: {
  approvalId: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ExecApprovalDecision;
  applied?: boolean;
}): ApprovalResolveResult {
  const decision = params.decision ?? "allow-once";
  const common = {
    id: params.approvalId,
    urlPath: `/approve/${params.approvalId}`,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    resolvedAtMs: 2,
    reason: "user" as const,
    presentation:
      params.approvalKind === "plugin"
        ? {
            kind: "plugin" as const,
            title: "Plugin request",
            description: "Allow the plugin action.",
            severity: "info" as const,
            allowedDecisions: ["allow-once" as const, "deny" as const],
          }
        : {
            kind: "exec" as const,
            commandText: "echo approved",
            commandPreview: null,
            allowedDecisions: ["allow-once" as const, "deny" as const],
          },
  };
  return decision === "deny"
    ? {
        applied: params.applied ?? true,
        approval: { ...common, status: "denied", decision: "deny" },
      }
    : {
        applied: params.applied ?? true,
        approval: { ...common, status: "allowed", decision },
      };
}

function createDeps(): MSTeamsMessageHandlerDeps {
  return createMSTeamsMessageHandlerDeps({
    cfg: { channels: { msteams: { allowFrom: [APPROVER_ID] } } },
  });
}

function createContext(params: {
  token?: string;
  senderId?: string;
  conversationId?: string;
  replyToId?: string;
  nested?: boolean;
  value?: unknown;
}): MSTeamsTurnContext {
  const approvalValue = {
    openclawAction: "approval",
    ...(params.token ? { token: params.token } : {}),
  };
  return {
    activity: {
      type: "message",
      from: { aadObjectId: params.senderId ?? APPROVER_ID },
      conversation: { id: params.conversationId ?? CONVERSATION_ID },
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      value:
        params.value ??
        (params.nested
          ? { action: { type: "Action.Submit", data: approvalValue } }
          : approvalValue),
    },
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => undefined),
    updateActivity: vi.fn(async () => ({ id: ACTIVITY_ID })),
    deleteActivity: vi.fn(async () => undefined),
  };
}

function registerBinding(params: {
  token: string;
  accountId?: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ExecApprovalDecision;
  allowedDecisions?: readonly ExecApprovalDecision[];
  conversationId?: string;
}): void {
  testTokens.add(params.token);
  msTeamsApprovalControls.register({
    token: params.token,
    accountId: params.accountId ?? "default",
    approvalId: `approval-${params.token}`,
    approvalKind: params.approvalKind ?? "exec",
    decision: params.decision ?? "allow-once",
    allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
    conversationId: params.conversationId ?? CONVERSATION_ID,
    activityId: ACTIVITY_ID,
    expiresAtMs: Date.now() + 60_000,
  });
}

describe("maybeHandleMSTeamsApprovalCardSubmit", () => {
  beforeEach(() => {
    resolveApprovalOverGateway
      .mockReset()
      .mockImplementation(
        (params: {
          approvalId: string;
          approvalKind: ChannelApprovalKind;
          decision: ExecApprovalDecision;
        }) => Promise.resolve(createResolution(params)),
      );
  });

  afterEach(() => {
    msTeamsApprovalControls.unregister(Array.from(testTokens));
    testTokens.clear();
  });

  it("leaves unrelated Adaptive Card submits available to normal message dispatch", async () => {
    const context = createContext({ value: { intent: "deploy", environment: "prod" } });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context, deps: createDeps() }),
    ).resolves.toBe(false);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", token: undefined },
    { label: "unknown", token: "unknown-token" },
  ])("consumes approval submits with a $label token", async ({ token }) => {
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "account",
      binding: { accountId: "another-account" },
      context: {},
    },
    {
      label: "conversation",
      binding: {},
      context: { conversationId: "19:another-conversation" },
    },
    {
      label: "activity",
      binding: {},
      context: { replyToId: "another-activity" },
    },
    {
      label: "decision",
      binding: { decision: "allow-always" as const },
      context: {},
    },
  ])("rejects a mismatched $label without consuming the token", async (scenario) => {
    const token = `mismatch-${scenario.label}`;
    registerBinding({ token, ...scenario.binding });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, ...scenario.context }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(msTeamsApprovalControls.get(token)).not.toBeNull();
  });

  it("requires an allowlisted AAD identity and preserves tokens for the authorized approver", async () => {
    const token = "authorization";
    registerBinding({ token, approvalKind: "plugin", decision: "deny" });
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, senderId: UNAUTHORIZED_ID }),
        deps,
      }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    const authorizedContext = createContext({ token, nested: true });
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: authorizedContext, deps }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: deps.cfg,
      approvalId: `approval-${token}`,
      approvalKind: "plugin",
      decision: "deny",
      channel: "msteams",
      accountId: "default",
      senderId: APPROVER_ID,
    });
    expect(authorizedContext.updateActivity).toHaveBeenCalledWith({
      type: "message",
      id: ACTIVITY_ID,
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: expect.objectContaining({ type: "AdaptiveCard" }),
        },
      ],
    });
    expect(JSON.stringify(vi.mocked(authorizedContext.updateActivity).mock.calls[0])).toContain(
      "Denied",
    );
    expect(msTeamsApprovalControls.get(token)).toBeNull();
  });

  it("normalizes Teams conversation message suffixes before matching their card", async () => {
    const token = "normalized-conversation";
    registerBinding({ token });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({
          token,
          conversationId: `${CONVERSATION_ID};messageid=thread-root`,
        }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
  });

  it("allows only one gateway resolution while simultaneous clicks are in flight", async () => {
    const token = "in-flight";
    registerBinding({ token });
    const deferred = createDeferred<ApprovalResolveResult>();
    resolveApprovalOverGateway.mockReturnValueOnce(deferred.promise);
    const deps = createDeps();
    const first = maybeHandleMSTeamsApprovalCardSubmit({
      context: createContext({ token }),
      deps,
    });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);

    deferred.resolve(createResolution({ approvalId: `approval-${token}` }));
    await expect(first).resolves.toBe(true);
  });

  it("releases the token after a recoverable gateway failure", async () => {
    const token = "gateway-retry";
    registerBinding({ token });
    resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).rejects.toThrow("gateway unavailable");
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  });

  it("retries a failed terminal card update with the canonical winning decision", async () => {
    const token = "update-retry";
    registerBinding({ token });
    resolveApprovalOverGateway.mockResolvedValue(
      createResolution({ approvalId: `approval-${token}`, decision: "deny", applied: false }),
    );
    const failedContext = createContext({ token });
    vi.mocked(failedContext.updateActivity).mockRejectedValueOnce(new Error("update failed"));
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: failedContext, deps }),
    ).rejects.toThrow("update failed");
    const retriedContext = createContext({ token });
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: retriedContext, deps }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
    const cardJson = JSON.stringify(vi.mocked(retriedContext.updateActivity).mock.calls[0]?.[0]);
    expect(cardJson).toContain("Exec Approval: Denied");
    expect(cardJson).toContain("Already resolved");
    expect(cardJson).not.toContain("Exec Approval: Allowed once");
    expect(msTeamsApprovalControls.get(token)).toBeNull();
  });

  it("retires permanently missing approvals and ignores subsequent clicks", async () => {
    const token = "not-found";
    registerBinding({ token });
    resolveApprovalOverGateway.mockRejectedValueOnce(
      Object.assign(new Error("approval no longer exists"), {
        gatewayCode: "APPROVAL_NOT_FOUND",
      }),
    );
    const deps = createDeps();
    const context = createContext({ token });

    await expect(maybeHandleMSTeamsApprovalCardSubmit({ context, deps })).resolves.toBe(true);
    expect(msTeamsApprovalControls.get(token)).toBeNull();
    expect(context.updateActivity).not.toHaveBeenCalled();

    await expect(maybeHandleMSTeamsApprovalCardSubmit({ context, deps })).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
  });
});
