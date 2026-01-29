import { describe, expect, it, vi } from "vitest";
import { MessageApprovalManager } from "../message-approval-manager.js";
import { createMessageApprovalHandlers } from "./message-approval.js";
import { validateMessageApprovalRequestParams } from "../protocol/index.js";

const noop = () => {};

describe("message approval handlers", () => {
  describe("MessageApprovalRequestParams validation", () => {
    it("accepts valid request params", () => {
      const params = {
        action: "send",
        channel: "telegram",
        to: "+1234567890",
        message: "Hello world",
      };
      expect(validateMessageApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with optional fields omitted", () => {
      const params = {
        action: "send",
        channel: "telegram",
        to: "+1234567890",
      };
      expect(validateMessageApprovalRequestParams(params)).toBe(true);
    });

    it("accepts request with null optional fields", () => {
      const params = {
        action: "send",
        channel: "telegram",
        to: "+1234567890",
        message: null,
        mediaUrl: null,
        agentId: null,
        sessionKey: null,
      };
      expect(validateMessageApprovalRequestParams(params)).toBe(true);
    });

    it("rejects request missing required fields", () => {
      const params = {
        action: "send",
        channel: "telegram",
        // missing 'to'
      };
      expect(validateMessageApprovalRequestParams(params)).toBe(false);
    });
  });

  it("broadcasts request + resolve", async () => {
    const manager = new MessageApprovalManager();
    const handlers = createMessageApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["message.approval.request"]({
      params: {
        action: "send",
        channel: "telegram",
        to: "+1234567890",
        message: "Test message",
        timeoutMs: 2000,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "message.approval.request" },
      isWebchatConnect: noop,
    });

    const requested = broadcasts.find((entry) => entry.event === "message.approval.requested");
    expect(requested).toBeTruthy();
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).not.toBe("");
    expect(id.startsWith("msg-")).toBe(true);

    const resolveRespond = vi.fn();
    await handlers["message.approval.resolve"]({
      params: { id, decision: "allow" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-2", type: "req", method: "message.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id, decision: "allow" }),
      undefined,
    );
    expect(broadcasts.some((entry) => entry.event === "message.approval.resolved")).toBe(true);
  });

  it("accepts resolve during broadcast", async () => {
    const manager = new MessageApprovalManager();
    const handlers = createMessageApprovalHandlers(manager);
    const respond = vi.fn();
    const resolveRespond = vi.fn();

    const resolveContext = {
      broadcast: () => {},
    };

    const context = {
      broadcast: (event: string, payload: unknown) => {
        if (event !== "message.approval.requested") return;
        const id = (payload as { id?: string })?.id ?? "";
        void handlers["message.approval.resolve"]({
          params: { id, decision: "allow" },
          respond: resolveRespond,
          context: resolveContext as unknown as Parameters<
            (typeof handlers)["message.approval.resolve"]
          >[0]["context"],
          client: { connect: { client: { id: "cli", displayName: "CLI" } } },
          req: { id: "req-2", type: "req", method: "message.approval.resolve" },
          isWebchatConnect: noop,
        });
      },
    };

    await handlers["message.approval.request"]({
      params: {
        action: "send",
        channel: "telegram",
        to: "+1234567890",
        message: "Test message",
        timeoutMs: 2000,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "message.approval.request" },
      isWebchatConnect: noop,
    });

    expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: "allow" }),
      undefined,
    );
  });

  it("accepts explicit approval ids", async () => {
    const manager = new MessageApprovalManager();
    const handlers = createMessageApprovalHandlers(manager);
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    const respond = vi.fn();
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["message.approval.request"]({
      params: {
        id: "msg-approval-123",
        action: "send",
        channel: "telegram",
        to: "+1234567890",
        message: "Test message",
        timeoutMs: 2000,
      },
      respond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "message.approval.request" },
      isWebchatConnect: noop,
    });

    const requested = broadcasts.find((entry) => entry.event === "message.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    expect(id).toBe("msg-approval-123");

    const resolveRespond = vi.fn();
    await handlers["message.approval.resolve"]({
      params: { id, decision: "allow" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-2", type: "req", method: "message.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: "msg-approval-123", decision: "allow" }),
      undefined,
    );
  });

  it("rejects duplicate approval ids", async () => {
    const manager = new MessageApprovalManager();
    const handlers = createMessageApprovalHandlers(manager);
    const respondA = vi.fn();
    const respondB = vi.fn();
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const context = {
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
    };

    const requestPromise = handlers["message.approval.request"]({
      params: {
        id: "msg-dup-1",
        action: "send",
        channel: "telegram",
        to: "+1234567890",
      },
      respond: respondA,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "message.approval.request" },
      isWebchatConnect: noop,
    });

    await handlers["message.approval.request"]({
      params: {
        id: "msg-dup-1",
        action: "send",
        channel: "slack",
        to: "U1234",
      },
      respond: respondB,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.request"]
      >[0]["context"],
      client: null,
      req: { id: "req-2", type: "req", method: "message.approval.request" },
      isWebchatConnect: noop,
    });

    expect(respondB).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "approval id already pending" }),
    );

    const requested = broadcasts.find((entry) => entry.event === "message.approval.requested");
    const id = (requested?.payload as { id?: string })?.id ?? "";
    const resolveRespond = vi.fn();
    await handlers["message.approval.resolve"]({
      params: { id, decision: "deny" },
      respond: resolveRespond,
      context: context as unknown as Parameters<
        (typeof handlers)["message.approval.resolve"]
      >[0]["context"],
      client: { connect: { client: { id: "cli", displayName: "CLI" } } },
      req: { id: "req-3", type: "req", method: "message.approval.resolve" },
      isWebchatConnect: noop,
    });

    await requestPromise;
  });

  it("rejects invalid decision", async () => {
    const manager = new MessageApprovalManager();
    const handlers = createMessageApprovalHandlers(manager);
    const respond = vi.fn();

    await handlers["message.approval.resolve"]({
      params: { id: "msg-123", decision: "allow-always" }, // invalid for message approvals
      respond,
      context: { broadcast: () => {} } as unknown as Parameters<
        (typeof handlers)["message.approval.resolve"]
      >[0]["context"],
      client: null,
      req: { id: "req-1", type: "req", method: "message.approval.resolve" },
      isWebchatConnect: noop,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid decision" }),
    );
  });
});
