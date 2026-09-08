import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type TestContext } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createApprovalScopeRequest(testContext: TestContext, scope: unknown) {
  const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
  const respond = vi.fn();
  const params = {
    title: "Sensitive action",
    description: "Review the action",
    scope,
    twoPhase: true,
  };
  const options = {
    req: { method: "plugin.approval.request", params, id: "request" },
    params,
    respond,
    client: { connId: "reviewer", connect: { client: { id: "reviewer" } } },
    context: {
      broadcast: vi.fn(),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
    },
  } as unknown as GatewayRequestHandlerOptions;
  const handler = expectDefined(
    createPluginApprovalHandlers(manager)["plugin.approval.request"],
    "plugin approval request handler",
  );
  return { manager, respond, handler, options };
}

describe("plugin approval request scopes", () => {
  it("sanitizes owner-declared scope before storing or broadcasting the approval", async (testContext) => {
    const { manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "message-send",
      target: "email\u202Esystem",
      recipientCount: 3,
      recipients: ["alice\u200B@example.com", "bob@example.com"],
      audience: "external",
    });
    const pending = handler(options);
    await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
    const record = expectDefined(manager.listPendingRecords()[0], "pending plugin approval");

    expect(record.request.scope).toEqual({
      kind: "message-send",
      target: "email\\u{202E}system",
      recipientCount: 3,
      recipients: ["alice\\u{200B}@example.com", "bob@example.com"],
      audience: "external",
    });
    manager.resolve(record.id, "allow-once");
    await pending;
  });

  it("drops scope after escaped text exceeds its bounds without rejecting approval", async (testContext) => {
    const { manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "external-post",
      target: `github${"\u202E".repeat(20)}`,
      visibility: "public",
    });
    const pending = handler(options);
    await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
    const record = expectDefined(manager.listPendingRecords()[0], "pending plugin approval");

    expect(record.request.scope).toBeNull();
    manager.resolve(record.id, "allow-once");
    await pending;
  });

  it.for([
    { kind: "untyped", target: "email" },
    { kind: "external-post", target: "github", visibility: "public", extra: true },
  ])("rejects malformed or non-closed owner-declared scope", async (scope, testContext) => {
    const { manager, respond, handler, options } = createApprovalScopeRequest(testContext, scope);
    await handler(options);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(manager.listPendingRecords()).toHaveLength(0);
  });
});
