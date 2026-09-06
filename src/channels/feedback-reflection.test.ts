import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { recordChannelFeedbackEvent, runChannelFeedbackReflection } from "./feedback-reflection.js";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "./message-access/admission-evidence.js";

const appendTranscriptEvent = vi.hoisted(() => vi.fn(async () => undefined));
const dispatchRoutedChannelTurn = vi.hoisted(() => vi.fn());
const loadSessionEntry = vi.hoisted(() => vi.fn());
const readSessionUpdatedAtCore = vi.hoisted(() => vi.fn());
const resolveSessionTranscriptRuntimeTarget = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: resolveStorePath,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  appendTranscriptEvent,
  loadSessionEntry,
  loadSessionEntryReadOnly: loadSessionEntry,
  readSessionUpdatedAtCore,
  resolveSessionTranscriptRuntimeTarget,
}));
vi.mock("./turn/lifecycle.js", () => ({ dispatchRoutedChannelTurn }));

const cfg = {} as OpenClawConfig;

describe("channel feedback reflection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies internal reflection as explicitly unsupported provenance", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
        expect(
          consumeChannelAdmissionEvidence(
            readChannelContextAdmissionEvidence(plan.ctxPayload as object),
          ),
        ).toMatchObject({ ingressState: "unsupported", decisionCoverage: "unsupported" });
        return { admission: { kind: "dispatch" }, dispatched: false };
      });
      await runChannelFeedbackReflection({
        cfg,
        channel: "msteams",
        channelLabel: "Teams",
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-unsupported",
        conversationId: "conversation-unsupported",
        conversationKind: "direct",
      });
    } finally {
      cleanup();
    }
  });

  it("runs reflection in the original session and enforces cooldown", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({
        text: JSON.stringify({
          learning: "Answer the direct question first.",
          followUp: true,
          userMessage: "Want a shorter version?",
        }),
      });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });
    const params = {
      cfg,
      channel: "msteams",
      channelLabel: "Teams",
      agentId: "main",
      sessionKey: "agent:main:msteams:feedback-1",
      conversationId: "conversation-1",
      conversationKind: "group" as const,
      thumbedDownResponse: "Too much detail",
      userComment: "Be concise",
    };

    await expect(runChannelFeedbackReflection(params)).resolves.toEqual({
      status: "complete",
      learning: "Answer the direct question first.",
      storePath: "/state/main/sessions.json",
      followUp: true,
      userMessage: "Want a shorter version?",
      responseLength: 104,
    });
    expect(dispatchRoutedChannelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        channel: "msteams",
        route: { agentId: "main", sessionKey: params.sessionKey },
        ctxPayload: expect.objectContaining({
          ChatType: "group",
          ConversationRouteContextObserved: false,
        }),
      }),
    );
    await expect(runChannelFeedbackReflection(params)).resolves.toEqual({ status: "cooldown" });
    expect(dispatchRoutedChannelTurn).toHaveBeenCalledTimes(1);
  });

  it("preserves a plain-text reflection as internal learning", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({ text: "Answer the direct question first." });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });

    await expect(
      runChannelFeedbackReflection({
        cfg,
        channel: "msteams",
        channelLabel: "Teams",
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-plain",
        conversationId: "conversation-plain",
        conversationKind: "direct",
      }),
    ).resolves.toEqual({
      status: "complete",
      learning: "Answer the direct question first.",
      storePath: "/state/main/sessions.json",
      followUp: false,
      userMessage: undefined,
      responseLength: 33,
    });
  });

  it("does not treat structured follow-up values as directives", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({
        text: JSON.stringify({ learning: "Be concise.", followUp: ["yes"] }),
      });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });

    await expect(
      runChannelFeedbackReflection({
        cfg,
        channel: "msteams",
        channelLabel: "Teams",
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-structured",
        conversationId: "conversation-structured",
        conversationKind: "direct",
      }),
    ).resolves.toMatchObject({ status: "complete", followUp: false });
  });

  it("records feedback through the persisted transcript owner", async () => {
    loadSessionEntry.mockReturnValue({ sessionId: "session-1" });
    resolveSessionTranscriptRuntimeTarget.mockResolvedValue({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: "/state/main/sessions.json",
    });
    const event = { type: "custom", event: "feedback", ts: 1 };

    await expect(
      recordChannelFeedbackEvent({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-2",
        event,
      }),
    ).resolves.toBe(true);
    expect(appendTranscriptEvent).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "/state/main/sessions.json",
      },
      event,
    );
  });

  it.each(["stored", "missing", "failed"] as const)(
    "notifies a typed subscriber without waiting when transcript is %s",
    async (outcome) => {
      loadSessionEntry.mockReturnValue(
        outcome === "missing" ? undefined : { sessionId: "session-1" },
      );
      resolveSessionTranscriptRuntimeTarget.mockResolvedValue({ sessionId: "session-1" });
      if (outcome === "failed") {
        appendTranscriptEvent.mockRejectedValueOnce(new Error("transcript unavailable"));
      }
      let release: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const subscriber = vi.fn(() => pending);
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "message_feedback", handler: subscriber }]),
      );
      try {
        const params = {
          cfg,
          agentId: "main",
          sessionKey: "agent:main:msteams:feedback",
          context: { channelId: "msteams", accountId: "default" },
          event: {
            type: "custom" as const,
            event: "feedback" as const,
            ts: 1,
            messageId: "response-1",
            value: "negative" as const,
            comment: "Be concise",
            senderId: "sender-1",
            senderName: "Sender",
            providerUpdate: { id: "invoke-1", kind: "message/submitAction" },
            agentId: "main",
            sessionKey: "agent:main:msteams:feedback",
            conversationId: "conversation-1",
          },
        };
        const result = recordChannelFeedbackEvent(params);
        if (outcome === "failed") {
          await expect(result).rejects.toThrow("transcript unavailable");
        } else {
          await expect(result).resolves.toBe(outcome === "stored");
        }
        expect(subscriber).toHaveBeenCalledExactlyOnceWith(
          {
            messageId: "response-1",
            value: "negative",
            timestamp: 1,
            comment: "Be concise",
            senderId: "sender-1",
            senderName: "Sender",
            providerUpdate: { id: "invoke-1", kind: "message/submitAction" },
          },
          {
            channelId: "msteams",
            accountId: "default",
            agentId: "main",
            sessionKey: params.sessionKey,
            conversationId: "conversation-1",
            messageId: "response-1",
            senderId: "sender-1",
          },
        );
      } finally {
        release();
        resetGlobalHookRunner();
      }
    },
  );
});
