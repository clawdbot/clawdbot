import { beforeEach, describe, expect, it, vi } from "vitest";
// Covers approval resolution over the gateway client.
import type { ApprovalResolveResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveApprovalOverGateway } from "./approval-gateway-resolver.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";

const hoisted = vi.hoisted(() => ({
  withOperatorApprovalsGatewayClient: vi.fn(),
  clientRequest: vi.fn(),
}));

const recordedApproval = {
  id: "approval-1",
  urlPath: "/approve/approval-1",
  createdAtMs: 1_000,
  expiresAtMs: 2_000,
  presentation: {
    kind: "exec",
    commandText: "printf approval",
    allowedDecisions: ["allow-once", "deny"],
  },
  status: "allowed",
  decision: "allow-once",
  resolvedAtMs: 1_500,
  reason: "user",
} satisfies ApprovalResolveResult["approval"];

vi.mock("../gateway/operator-approvals-client.js", () => ({
  withOperatorApprovalsGatewayClient: hoisted.withOperatorApprovalsGatewayClient,
}));

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected gateway client call");
  }
  return call;
}

function withApprovalAccountContext<T>(run: () => T): T {
  return withGatewayNativeApprovalRuntime(
    {
      request: async <TResult>(method: string, params: Record<string, unknown>) =>
        (await hoisted.clientRequest(method, params)) as TResult,
      requestRoute: vi.fn(),
      routeCoordinator: {} as never,
      subscribe: vi.fn(),
    },
    run,
  );
}

describe("resolveApprovalOverGateway", () => {
  beforeEach(() => {
    hoisted.clientRequest.mockReset().mockResolvedValue({
      applied: true,
      approval: recordedApproval,
    });
    hoisted.withOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (_, run) => {
      return await run({ request: hoisted.clientRequest });
    });
  });

  it("resolves an explicit exec kind through the canonical method", async () => {
    const result = await resolveApprovalOverGateway({
      cfg: { gateway: { auth: { token: "cfg-token" } } } as never,
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      gatewayUrl: "ws://gateway.example.test",
      clientDisplayName: "QuietChat approval (default)",
    });

    expect(hoisted.withOperatorApprovalsGatewayClient).toHaveBeenCalledTimes(1);
    const [gatewayClientOptions, gatewayClientRunner] = requireFirstMockCall(
      hoisted.withOperatorApprovalsGatewayClient,
    );
    expect(gatewayClientOptions).toEqual({
      config: { gateway: { auth: { token: "cfg-token" } } },
      gatewayUrl: "ws://gateway.example.test",
      clientDisplayName: "QuietChat approval (default)",
    });
    expect(gatewayClientRunner).toBeTypeOf("function");
    expect(hoisted.clientRequest).toHaveBeenCalledWith("approval.resolve", {
      id: "approval-1",
      kind: "exec",
      decision: "allow-once",
    });
    expect(result).toEqual({ applied: true, approval: recordedApproval });
  });

  it("sends complete reviewer facts directly to the canonical owner", async () => {
    await expect(
      withApprovalAccountContext(() =>
        resolveApprovalOverGateway({
          cfg: {} as never,
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "deny",
          channel: "telegram",
          accountId: "ops",
          senderId: "owner",
        }),
      ),
    ).resolves.toEqual({ applied: true, approval: recordedApproval });
    expect(hoisted.clientRequest).toHaveBeenCalledWith("approval.resolve", {
      id: "approval-1",
      kind: "exec",
      decision: "deny",
      reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
    });
  });

  it.each([
    { channel: "telegram" },
    { accountId: "ops" },
    { senderId: "owner" },
    { channel: "telegram", accountId: "ops" },
    { channel: "telegram", senderId: "owner" },
    { accountId: "ops", senderId: "owner" },
  ])("rejects partial reviewer identity: %j", async (reviewer) => {
    await expect(
      resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "deny",
        ...reviewer,
      }),
    ).rejects.toThrow("channel approval resolution requires channel, account, and sender identity");
    expect(hoisted.clientRequest).not.toHaveBeenCalled();
    expect(hoisted.withOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it.each([
    ["signal", "Signal"],
    ["whatsapp", "WhatsApp"],
    ["matrix", "Matrix"],
    ["imessage", "iMessage"],
    ["telegram", "Telegram"],
    ["discord", "Discord"],
    ["googlechat", "Google Chat"],
    ["slack", "Slack"],
  ] as const)(
    "derives the %s approval client label from channel metadata",
    async (channel, label) => {
      await resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "deny",
        channel,
        accountId: "default",
        senderId: "owner",
      });

      const [gatewayClientOptions] = requireFirstMockCall(
        hoisted.withOperatorApprovalsGatewayClient,
      );
      expect(gatewayClientOptions).toMatchObject({
        clientDisplayName: `${label} approval (owner)`,
      });
    },
  );

  it("preserves the raw id in the approval label for unknown channels", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "deny",
      channel: "external-chat",
      accountId: "default",
      senderId: "owner",
    });

    const [gatewayClientOptions] = requireFirstMockCall(hoisted.withOperatorApprovalsGatewayClient);
    expect(gatewayClientOptions).toMatchObject({
      clientDisplayName: "external-chat approval (owner)",
    });
  });

  it("uses explicit plugin kind without inspecting the approval id", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "opaque-approval-id",
      approvalKind: "plugin",
      decision: "deny",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("approval.resolve", {
      id: "opaque-approval-id",
      kind: "plugin",
      decision: "deny",
    });
  });

  it("uses the channel task's owning Gateway principal without opening a client", async () => {
    const request = vi.fn(async () => ({ applied: true, approval: recordedApproval }));
    const result = await withGatewayNativeApprovalRuntime(
      {
        request: request as GatewayNativeApprovalRuntime["request"],
        requestRoute: vi.fn(),
        routeCoordinator: {} as never,
        subscribe: vi.fn(),
      },
      async () =>
        await resolveApprovalOverGateway({
          cfg: {} as never,
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "deny",
        }),
    );

    expect(request).toHaveBeenCalledWith(
      "approval.resolve",
      {
        id: "approval-1",
        kind: "exec",
        decision: "deny",
      },
      { clientDisplayName: "Approval (unknown)" },
    );
    expect(result).toEqual({ applied: true, approval: recordedApproval });
    expect(hoisted.withOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("uses an explicitly injected channel approval runtime", async () => {
    const request = vi.fn(async () => ({ applied: true, approval: recordedApproval }));
    await expect(
      resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "deny",
        gatewayRuntime: { request },
      }),
    ).resolves.toEqual({ applied: true, approval: recordedApproval });

    expect(request).toHaveBeenCalledWith(
      "approval.resolve",
      { id: "approval-1", kind: "exec", decision: "deny" },
      { clientDisplayName: "Approval (unknown)" },
    );
    expect(hoisted.withOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("sends channel custody to an injected canonical runtime", async () => {
    const injectedRequest = vi.fn(async () => ({ applied: true, approval: recordedApproval }));
    const scopedRequest = vi.fn();
    const runtime = {
      request: async <T>(): Promise<T> => {
        scopedRequest();
        throw new Error("unexpected scoped approval request");
      },
      requestRoute: vi.fn(),
      routeCoordinator: { doesAccountHandleRequest: () => true } as never,
      subscribe: vi.fn(),
    } satisfies GatewayNativeApprovalRuntime;

    await expect(
      withGatewayNativeApprovalRuntime(runtime, () =>
        resolveApprovalOverGateway({
          cfg: {} as never,
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "deny",
          channel: "imessage",
          accountId: "personal",
          senderId: "owner",
          gatewayRuntime: { request: injectedRequest },
        }),
      ),
    ).resolves.toEqual({ applied: true, approval: recordedApproval });

    expect(injectedRequest).toHaveBeenCalledWith(
      "approval.resolve",
      {
        id: "approval-1",
        kind: "exec",
        decision: "deny",
        reviewer: { channel: "imessage", accountId: "personal", senderId: "owner" },
      },
      { clientDisplayName: "iMessage approval (owner)" },
    );
    expect(scopedRequest).not.toHaveBeenCalled();
  });

  it("preserves protocol-valid boundary whitespace in canonical approval ids", async () => {
    const approvalId = "\uFEFF";

    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId,
      approvalKind: "exec",
      decision: "deny",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledWith("approval.resolve", {
      id: approvalId,
      kind: "exec",
      decision: "deny",
    });
  });

  it("returns the canonical winner when another surface resolved first", async () => {
    hoisted.clientRequest.mockResolvedValueOnce({
      applied: false,
      approval: recordedApproval,
    });

    const result = await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "deny",
    });
    expect(result).toEqual({ applied: false, approval: recordedApproval });
  });

  it("propagates canonical resolve failures without fallback routing", async () => {
    hoisted.clientRequest.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "deny",
      }),
    ).rejects.toThrow("permission denied");

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
  });

  it("routes an explicit plugin legacy method without inspecting the id", async () => {
    const result = await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "opaque-plugin-id",
      decision: "deny",
      resolveMethod: "plugin",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "opaque-plugin-id",
      decision: "deny",
    });
    expect(result).toBeUndefined();
  });

  it("routes an explicit exec legacy method without fallback", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "plugin:opaque-id",
      decision: "allow-always",
      resolveMethod: "exec",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "plugin:opaque-id",
      decision: "allow-always",
    });
  });

  it("preserves shipped no-kind exec routing and void output", async () => {
    const result = await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      decision: "deny",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "deny",
    });
    expect(result).toBeUndefined();
  });

  it("preserves shipped plugin-prefix routing for no-kind callers", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "plugin:approval-1",
      decision: "allow-once",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "plugin:approval-1",
      decision: "allow-once",
    });
  });

  it("preserves shipped not-found plugin fallback for no-kind callers", async () => {
    const notFoundError = Object.assign(new Error("unknown or expired approval id"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    hoisted.clientRequest.mockRejectedValueOnce(notFoundError).mockResolvedValueOnce({ ok: true });

    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      decision: "allow-always",
      allowPluginFallback: true,
    });

    expect(hoisted.clientRequest.mock.calls).toEqual([
      ["exec.approval.resolve", { id: "approval-1", decision: "allow-always" }],
      ["plugin.approval.resolve", { id: "approval-1", decision: "allow-always" }],
    ]);
  });

  it("does not run the legacy fallback for non-not-found failures", async () => {
    hoisted.clientRequest.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        decision: "deny",
        allowPluginFallback: true,
      }),
    ).rejects.toThrow("permission denied");
    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { approvalId: "approval-1", approvalKind: "bogus", decision: "deny" },
    { approvalId: "approval-1", resolveMethod: "bogus", decision: "deny" },
    { approvalId: "approval-1", allowPluginFallback: "yes", decision: "deny" },
    { approvalId: "approval-1", gatewayRuntime: { request: vi.fn() }, decision: "deny" },
    {
      approvalId: "approval-1",
      approvalKind: "exec",
      resolveMethod: "plugin",
      decision: "deny",
    },
    {
      approvalId: "approval-1",
      approvalKind: "exec",
      allowPluginFallback: false,
      decision: "deny",
    },
  ])("rejects malformed routing before opening a gateway client", async (input) => {
    await expect(resolveApprovalOverGateway({ cfg: {}, ...input } as never)).rejects.toThrow(
      "approval resolution requires",
    );
    expect(hoisted.withOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it.each([
    { approvalId: "", approvalKind: "exec", decision: "deny" },
    { approvalId: ".", approvalKind: "exec", decision: "deny" },
    { approvalId: "..", approvalKind: "exec", decision: "deny" },
    { approvalId: "approval-\uD800", approvalKind: "exec", decision: "deny" },
    { approvalId: "approval-\uDC00", approvalKind: "exec", decision: "deny" },
    { approvalId: "approval-1", approvalKind: "exec", decision: "accept" },
  ])("rejects malformed approval input before opening a gateway client", async (input) => {
    await expect(resolveApprovalOverGateway({ cfg: {}, ...input } as never)).rejects.toThrow(
      "approval resolution requires",
    );
    expect(hoisted.withOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });
});
