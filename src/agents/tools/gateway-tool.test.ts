import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGatewayTool } from "./gateway-tool.js";

const { callGatewayToolMock, dispatchMock, host } = vi.hoisted(() => ({
  dispatchMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  host: { context: {} as GatewayRequestContext | undefined },
  callGatewayToolMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("../../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: dispatchMock,
  getInProcessGatewayRequestContext: (resolve?: () => GatewayRequestContext | undefined) =>
    resolve ? resolve() : host.context,
  hasInProcessGatewayContext: (resolve?: () => GatewayRequestContext | undefined) =>
    Boolean(resolve ? resolve() : host.context),
}));

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockResolvedValue({ ok: true });
  });

  it("exposes config reads and owner-only updates", () => {
    const tool = createGatewayTool();
    const parameters = tool.parameters as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(parameters.properties?.action?.enum).toEqual([
      "config.get",
      "config.schema.lookup",
      "update.run",
    ]);
    expect(tool.description).toBe(
      "Read gateway config/schema. update.run: owner-only update on explicit user request; restart + completion notice automatic. Never via shell.",
    );
  });

  it.each(["restart", "config.apply", "config.patch"])(
    "rejects removed action %s",
    async (action) => {
      const tool = createGatewayTool();

      await expect(tool.execute?.("tool-call", { action })).rejects.toThrow(
        `Unknown action: ${action}`,
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["config.get", { action: "config.get" }],
    ["config.schema.lookup", { action: "config.schema.lookup", path: "channels" }],
  ])("forwards the abort signal for %s", async (method, params) => {
    const controller = new AbortController();

    await createGatewayTool().execute("tool-call", params, controller.signal);

    expect(callGatewayToolMock).toHaveBeenCalledWith(method, expect.anything(), expect.anything(), {
      signal: controller.signal,
    });
  });
});

describe("gateway update action", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    dispatchMock.mockReset();
    host.context = {} as GatewayRequestContext;
  });

  it.each([false, undefined])("requires an explicit owner identity (%s)", async (senderIsOwner) => {
    const result = await createGatewayTool({ senderIsOwner }).execute("update", {
      action: "update.run",
    });
    expect(result.details).toEqual({
      ok: false,
      code: "owner_required",
      message:
        "Only the OpenClaw owner can start an update from chat. Tell the user to run `openclaw update` in a terminal or use the Control UI.",
    });
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, "topic-42"])(
    "uses trusted chat routing and ignores model overrides (thread %s)",
    async (threadId) => {
      dispatchMock.mockResolvedValue({
        ok: true,
        result: {
          status: "skipped",
          mode: "npm",
          reason: "managed-service-update-handoff",
          before: { version: "2026.9.1" },
        },
        handoff: { status: "started", command: "openclaw update --timeout 1200", pid: 123 },
        restart: { ok: true, delayMs: 2000, pid: 456 },
        sentinel: { payload: "private-runtime-state" },
        ackDelivered: true,
      });
      const signal = new AbortController().signal;
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:123",
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
          turnSourceAccountId: "primary",
          turnSourceThreadId: threadId,
        },
        () =>
          createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }).execute(
            "update",
            {
              action: "update.run",
              note: "Requested update",
              sessionKey: "spoofed",
              deliveryContext: { channel: "discord", to: "other" },
              gatewayUrl: "wss://other.example",
              gatewayToken: "model-token",
              timeoutMs: 1,
            },
            signal,
          ),
      );
      expect(dispatchMock).toHaveBeenCalledExactlyOnceWith(
        "update.run",
        {
          requester: { channel: "telegram", accountId: "primary", senderId: "owner" },
          sessionKey: "agent:main:telegram:direct:123",
          deliveryContext: {
            channel: "telegram",
            to: "123",
            accountId: "primary",
            ...(threadId !== undefined ? { threadId } : {}),
          },
          note: "Requested update",
          timeoutMs: 1_200_000,
        },
        {
          signal,
          timeoutMs: 1_200_000,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          syntheticScopes: ["operator.admin"],
          resolveGatewayContext: expect.any(Function),
        },
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({
        ok: true,
        status: "skipped",
        before: { version: "2026.9.1" },
        restart: { scheduled: true, delayMs: 2000 },
        ackDelivered: true,
        failedSteps: [],
      });
      const serialized = JSON.stringify(result.details);
      expect(serialized).not.toContain("sentinel");
      expect(serialized).not.toContain('"pid"');
      expect(serialized).toContain("do not run shell commands or restart anything");
    },
  );

  it("still calls without a caller session", async () => {
    dispatchMock.mockResolvedValue({ ok: true, result: { status: "ok", steps: [] } });
    const result = await createGatewayTool({ senderIsOwner: true }).execute("update", {
      action: "update.run",
    });
    expect(dispatchMock).toHaveBeenCalledOnce();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ ok: true });
  });

  it("refuses an update without a hosting gateway instead of using a remote client", async () => {
    host.context = undefined;
    await expect(
      createGatewayTool({ senderIsOwner: true }).execute("update", { action: "update.run" }),
    ).rejects.toThrow("Gateway instance unavailable for update.run");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each([1, 20])("bounds %i noisy failed steps and preserves handoff text", async (stepCount) => {
    const command = `openclaw update --tag ${"v".repeat(520)}`;
    const message = `${"Recovery instructions. ".repeat(36)}Run ${command} in a terminal.`;
    dispatchMock.mockResolvedValue({
      ok: false,
      result: {
        status: "error",
        reason: "managed-service-handoff-unavailable",
        mode: "npm",
        steps: [
          { name: "passed", exitCode: 0, stderrTail: "do not include" },
          ...Array.from({ length: stepCount }, (_, i) => ({
            name: `failed-${i}`,
            exitCode: 1,
            stderrTail: "\u0000".repeat(3000) + "failure tail",
          })),
        ],
      },
      handoff: { status: "unavailable", command, message },
    });
    const result = await createGatewayTool({ senderIsOwner: true }).execute("update", {
      action: "update.run",
    });
    const text = result.content.find((block) => block.type === "text");
    expect(text?.type === "text" && text.text.length).toBeLessThan(4000);
    expect(result.details).toMatchObject({
      ok: false,
      status: "error",
      handoff: { command, message },
    });
    expect(JSON.stringify(result.details)).not.toContain("do not include");
    expect(result.details).toMatchObject({
      failedSteps: Array.from({ length: Math.min(3, stepCount) }, (_, index) => ({
        name: `failed-${Math.max(0, stepCount - 3) + index}`,
      })),
    });
    expect(JSON.stringify(result.details)).toContain(`Run ${command} in a terminal.`);
  });

  it("preserves long manual instructions without repeating them", async () => {
    const command = `openclaw update --tag ${"v".repeat(1100)}`;
    const message = "Recovery instructions. ".repeat(90);
    dispatchMock.mockResolvedValue({
      ok: false,
      result: { status: "skipped", steps: [] },
      handoff: { status: "unavailable", command, message },
    });
    const result = await createGatewayTool({ senderIsOwner: true }).execute("update", {
      action: "update.run",
    });
    expect(result.details).toMatchObject({ handoff: { command, message } });
    expect(JSON.stringify(result.details, null, 2).length).toBeLessThan(4000);
    expect(JSON.stringify(result.details)).toContain("exact manual instructions in handoff");
  });

  it("preserves oversized manual instructions without throwing or truncating", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      result: { status: "skipped", steps: [] },
      handoff: { status: "unavailable", command: "x".repeat(4000) },
    });
    const result = await createGatewayTool({ senderIsOwner: true }).execute("update", {
      action: "update.run",
    });
    expect(result.details).toMatchObject({ handoff: { command: "x".repeat(4000) } });
  });
});
