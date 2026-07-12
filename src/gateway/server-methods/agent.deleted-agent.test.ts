import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { agentHandlers } from "./agent.js";
import {
  mockDeletedAgentSession,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";
import type { RespondFn } from "./types.js";

const agentCommandFromIngressMock = vi.hoisted(() => vi.fn());
const performGatewaySessionResetMock = vi.hoisted(() => vi.fn());
const parseMessageWithAttachmentsMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: agentCommandFromIngressMock,
}));

vi.mock("../session-reset-service.js", () => ({
  performGatewaySessionReset: performGatewaySessionResetMock,
  emitGatewaySessionEndPluginHook: vi.fn(),
  emitGatewaySessionStartPluginHook: vi.fn(),
}));

vi.mock("../chat-attachments.js", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  return {
    ...actual,
    parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  };
});

describe("agent RPC deleted-agent guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
    agentCommandFromIngressMock.mockReset();
    performGatewaySessionResetMock.mockReset();
    parseMessageWithAttachmentsMock.mockReset();
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const orphanKey = mockDeletedAgentSession();

    const respond = vi.fn() as unknown as RespondFn;

    await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
      agentHandlers,
      {
        req: { id: "req-1" } as never,
        params: {
          sessionKey: orphanKey,
          message: "hi",
          idempotencyKey: "run-1",
        },
        respond,
        context: {
          dedupe: new Map(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
        } as never,
        client: null,
        isWebchatConnect: () => false,
      },
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });

  it("rejects deleted-agent sessions before media offload or dedupe reservation", async () => {
    const orphanKey = mockDeletedAgentSession();

    const respond = vi.fn() as unknown as RespondFn;
    const dedupe = new Map();

    await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
      agentHandlers,
      {
        req: { id: "req-attach" } as never,
        params: {
          sessionKey: orphanKey,
          message: "see attachment",
          idempotencyKey: "run-attach",
          attachments: [
            { type: "file", mimeType: "application/pdf", fileName: "doc.pdf", content: "aGVsbG8=" },
          ],
        },
        respond,
        context: {
          dedupe,
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
        } as never,
        client: null,
        isWebchatConnect: () => false,
      },
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    expect(dedupe.size).toBe(0);
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });

  it.each(["/reset", "/reset follow up"])(
    "rejects deleted-agent session keys before %s handling",
    async (message) => {
      const orphanKey = mockDeletedAgentSession();

      const respond = vi.fn() as unknown as RespondFn;

      await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
        agentHandlers,
        {
          req: { id: "req-reset" } as never,
          params: {
            sessionKey: orphanKey,
            message,
            idempotencyKey: `run-reset-${message}`,
          },
          respond,
          context: {
            dedupe: new Map(),
            chatAbortControllers: new Map(),
            getRuntimeConfig: () => ({}),
          } as never,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          isWebchatConnect: () => false,
        },
      );

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      });
      expect(performGatewaySessionResetMock).not.toHaveBeenCalled();
      expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
    },
  );

  it("rejects deleted-agent sessions before stale exec followup dedupe", async () => {
    const orphanKey = mockDeletedAgentSession();

    const respond = vi.fn() as unknown as RespondFn;
    const dedupe = new Map();

    await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
      agentHandlers,
      {
        req: { id: "req-followup" } as never,
        params: {
          sessionKey: orphanKey,
          message: "approval followup",
          idempotencyKey: "exec-approval-followup:req-followup",
          execApprovalFollowupExpectedSessionId: "old-session",
        },
        respond,
        context: {
          dedupe,
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
        } as never,
        client: { connect: { client: { mode: "backend" } } } as never,
        isWebchatConnect: () => false,
      },
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
    expect(dedupe.size).toBe(0);
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });
});
