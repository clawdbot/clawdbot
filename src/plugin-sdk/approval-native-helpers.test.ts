import { describe, expect, it } from "vitest";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalForwardingFallbackSuppressor,
  type NativeApprovalTarget,
  nativeApprovalTargetsMatch,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "./approval-native-helpers.js";
import type { OpenClawConfig } from "./config-runtime.js";

const EMPTY_SESSION_CFG = {
  session: {
    store: ".artifacts/test/approval-native-helpers-empty-sessions.json",
  },
} satisfies OpenClawConfig;

describe("createChannelNativeOriginTargetResolver", () => {
  it("reuses shared turn-source routing and respects shouldHandle gating", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "matrix",
      shouldHandleRequest: ({ accountId }) => accountId === "ops",
      resolveTurnSourceTarget: (request) => ({
        to: String(request.request.turnSourceTo),
        threadId: request.request.turnSourceThreadId ?? undefined,
      }),
      resolveSessionTarget: (sessionTarget) => ({
        to: sessionTarget.to,
        threadId: sessionTarget.threadId,
      }),
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        accountId: "ops",
        request: {
          id: "plugin:req-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!room:example.org",
            turnSourceThreadId: "t1",
            turnSourceAccountId: "ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({
      to: "room:!room:example.org",
      threadId: "t1",
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        accountId: "other",
        request: {
          id: "plugin:req-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!room:example.org",
            turnSourceThreadId: "t1",
            turnSourceAccountId: "ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBeNull();
  });

  it("uses shared route semantics for the default target matcher", () => {
    expect(
      nativeApprovalTargetsMatch({
        channel: "telegram",
        left: { to: "-100123", threadId: 42.9 },
        right: { to: "-100123", threadId: "42" },
      }),
    ).toBe(true);
    expect(
      nativeApprovalTargetsMatch({
        channel: "telegram",
        left: { to: "-100123", accountId: "work" },
        right: { to: "-100123" },
      }),
    ).toBe(false);

    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "telegram",
      resolveTurnSourceTarget: () => ({ to: "-100123", threadId: 42.9 }),
      resolveSessionTarget: () => ({ to: "-100123", threadId: "42" }),
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "telegram",
            turnSourceTo: "-100123",
            turnSourceThreadId: 42.9,
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({ to: "-100123", threadId: 42.9 });
  });

  it("normalizes resolved targets before matching origin candidates", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "slack",
      resolveTurnSourceTarget: () => ({ to: "CHANNEL:C1", threadId: "171234.567890" }),
      resolveSessionTarget: () => ({ to: "channel:c1", threadId: "171234.567890" }),
      normalizeTarget: (target) => ({
        ...target,
        to: target.to.toLowerCase(),
      }),
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "CHANNEL:C1",
            turnSourceThreadId: "171234.567890",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({ to: "channel:c1", threadId: "171234.567890" });
  });

  it("normalizes custom target shapes before invoking a custom matcher", () => {
    type ProviderTarget = { id: string; shard?: string };

    const resolveOriginTarget = createChannelNativeOriginTargetResolver<ProviderTarget>({
      channel: "custom",
      resolveTurnSourceTarget: () => ({ id: "ROOM-1", shard: "a" }),
      resolveSessionTarget: () => ({ id: "room-1", shard: "b" }),
      normalizeTarget: (target) => ({ ...target, id: target.id.toLowerCase() }),
      targetsMatch: (left, right) => left.id === right.id,
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            sessionKey: "agent:main:custom:room-1",
            turnSourceChannel: "custom",
            turnSourceTo: "ROOM-1",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({ id: "room-1", shard: "a" });
  });

  it("normalizes only match inputs when delivery targets must stay provider-native", () => {
    const resolveOriginTarget = createChannelNativeOriginTargetResolver<NativeApprovalTarget>({
      channel: "slack",
      resolveTurnSourceTarget: () => ({ to: "channel:C1", threadId: "171234.567890" }),
      resolveSessionTarget: () => ({ to: "channel:c1", threadId: "171234.567890" }),
      normalizeTargetForMatch: (target) => ({
        ...target,
        to: target.to.toLowerCase(),
      }),
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C1",
            turnSourceThreadId: "171234.567890",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({ to: "channel:C1", threadId: "171234.567890" });
  });

  it("keeps custom target matchers generic", () => {
    type ProviderTarget = { id: string; shard?: string };

    const resolveOriginTarget = createChannelNativeOriginTargetResolver<ProviderTarget>({
      channel: "custom",
      resolveTurnSourceTarget: () => ({ id: "room-1", shard: "a" }),
      resolveSessionTarget: () => ({ id: "room-1", shard: "b" }),
      targetsMatch: (left, right) => left.id === right.id,
    });

    expect(
      resolveOriginTarget({
        cfg: EMPTY_SESSION_CFG,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            sessionKey: "agent:main:custom:room-1",
            turnSourceChannel: "custom",
            turnSourceTo: "room-1",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({ id: "room-1", shard: "a" });
  });
});

describe("createChannelApproverDmTargetResolver", () => {
  it("filters null targets and skips delivery when shouldHandle rejects the request", () => {
    const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
      shouldHandleRequest: ({ approvalKind }) => approvalKind === "exec",
      resolveApprovers: () => ["owner-1", "owner-2", "skip-me"],
      mapApprover: (approver) =>
        approver === "skip-me"
          ? null
          : {
              to: `user:${approver}`,
            },
    });

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual([{ to: "user:owner-1" }, { to: "user:owner-2" }]);

    expect(
      resolveApproverDmTargets({
        cfg: {},
        accountId: "default",
        approvalKind: "plugin",
        request: {
          id: "plugin:req-1",
          request: { title: "Plugin approval", description: "Allow access" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toStrictEqual([]);
  });
});

describe("createNativeApprovalForwardingFallbackSuppressor", () => {
  const execRequest = {
    id: "req-1",
    request: {
      command: "echo hi",
      turnSourceChannel: "matrix",
      turnSourceTo: "room-1",
      turnSourceAccountId: "default",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };

  function createSuppressor(
    overrides: Partial<Parameters<typeof createNativeApprovalForwardingFallbackSuppressor>[0]> = {},
  ) {
    return createNativeApprovalForwardingFallbackSuppressor({
      channel: "matrix",
      normalizeForwardTarget: (target) =>
        target.channel === "matrix"
          ? { to: target.to, accountId: target.accountId ?? undefined }
          : null,
      resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
        ...forwardingTarget,
        accountId,
      }),
      isSessionRouteEligible: ({ approvalKind }) => approvalKind === "exec",
      resolveOriginTarget: () => ({ to: "room-1", accountId: "default" }),
      resolveApproverDmTargets: () => [{ to: "user-1", accountId: "default" }],
      ...overrides,
    });
  }

  it("suppresses session forwarding only when a native origin or approver DM matches", () => {
    const shouldSuppress = createSuppressor();

    expect(
      shouldSuppress({
        cfg: {},
        approvalKind: "exec",
        target: { channel: "matrix", to: "room-1", source: "session" },
        request: execRequest,
      }),
    ).toBe(true);
    expect(
      shouldSuppress({
        cfg: {},
        approvalKind: "exec",
        target: { channel: "matrix", to: "user-1", source: "session" },
        request: execRequest,
      }),
    ).toBe(true);
    expect(
      shouldSuppress({
        cfg: {},
        approvalKind: "exec",
        target: { channel: "matrix", to: "other-room", source: "session" },
        request: execRequest,
      }),
    ).toBe(false);
  });

  it("requires explicit-target eligibility before suppressing target forwarding", () => {
    expect(
      createSuppressor()({
        cfg: {},
        approvalKind: "exec",
        target: { channel: "matrix", to: "room-1", source: "target" },
        request: execRequest,
      }),
    ).toBe(false);

    expect(
      createSuppressor({
        isExplicitTargetEligible: () => true,
      })({
        cfg: {},
        approvalKind: "exec",
        target: { channel: "matrix", to: "room-1", source: "target" },
        request: execRequest,
      }),
    ).toBe(true);
  });
});

describe("shouldSuppressLocalNativeExecApprovalPrompt", () => {
  const payload = {
    text: "Approval required.",
    channelData: {
      execApproval: {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        agentId: "main",
        sessionKey: "agent:main:discord:direct:123",
      },
    },
  };
  const activeExecHint = {
    kind: "approval-pending",
    approvalKind: "exec",
    nativeRouteActive: true,
  } as const;

  it("supports strict top-level native exec suppression", () => {
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: {
          approvals: {
            exec: {
              enabled: true,
              agentFilter: ["main"],
            },
          },
        },
        payload,
        hint: activeExecHint,
        isTransportEnabled: () => true,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: {
          approvals: {
            exec: {
              enabled: true,
              agentFilter: ["other"],
            },
          },
        },
        payload,
        hint: activeExecHint,
        isTransportEnabled: () => true,
      }),
    ).toBe(false);
  });

  it("supports channel-specific native exec client gates", () => {
    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: {},
        payload,
        hint: activeExecHint,
        isNativeDeliveryEnabled: () => true,
        resolveApprovalConfig: () => ({
          enabled: true,
          sessionFilter: ["discord:direct"],
        }),
        enforceForwardingMode: false,
        fallbackAgentIdFromSessionKey: false,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalNativeExecApprovalPrompt({
        cfg: {},
        payload,
        hint: activeExecHint,
        isNativeDeliveryEnabled: () => false,
        resolveApprovalConfig: () => ({
          enabled: true,
          sessionFilter: ["discord:direct"],
        }),
        enforceForwardingMode: false,
        fallbackAgentIdFromSessionKey: false,
      }),
    ).toBe(false);
  });
});
