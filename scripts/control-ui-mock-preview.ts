import type {
  SystemAgentChatQuestion,
  SystemAgentChatResult,
} from "../packages/gateway-protocol/src/index.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

// Serialized into the preview page; runtime dependencies must stay inside this function.
function installControlUiPreview(): void {
  const previewWindow = window as Window & {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string };
    openclawControlUiE2eGateway?: ControlUiMockGateway;
  };
  // The WebSocket mock does not intercept HTTP. Select this origin before
  // application startup can send synthetic resources to the operator Gateway.
  const gatewayUrl = new URL(window.location.origin);
  gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  previewWindow["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl: gatewayUrl.origin };

  const gateway = previewWindow.openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Preview Gateway must be installed before its request handlers");
  }

  gateway.setRequestHandler("chat.send", ({ params, respond, emit }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const runId =
      typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey
        : "control-ui-mock-run";
    const sessionKey =
      typeof input.sessionKey === "string" && input.sessionKey.trim()
        ? input.sessionKey
        : "agent:main:main";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    window.setTimeout(() => {
      respond({ runId, status: "started" });
      // The client must observe admission before the final event for this run.
      window.setTimeout(
        () =>
          emit("chat", {
            message: {
              content: [{ text: `Mock reply: ${message || "message received"}`, type: "text" }],
              role: "assistant",
              timestamp: Date.now(),
            },
            runId,
            seq: 1,
            sessionKey,
            state: "final",
          }),
        0,
      );
    }, 200);
  });

  const sessionTurns = new Map<string, number>();
  const channelQuestion = {
    id: "mock-channel-choice",
    header: "Channel setup",
    question: "Which channel would you like to work on?",
    options: [
      {
        label: "WhatsApp",
        reply: "help me connect WhatsApp",
        description: "Review linking and account status.",
        recommended: true,
      },
      {
        label: "Telegram",
        reply: "help me connect Telegram",
        description: "Review the bot token and delivery status.",
      },
      {
        label: "Discord",
        reply: "help me connect Discord",
        description: "Review the bot and server connection.",
      },
    ],
    isOther: true,
  } satisfies SystemAgentChatQuestion;
  gateway.setRequestHandler("openclaw.chat", ({ params, respond }) => {
    const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const sessionId =
      typeof input.sessionId === "string" && input.sessionId.trim()
        ? input.sessionId
        : "control-ui-custodian-mock";
    const message = typeof input.message === "string" ? input.message : undefined;
    const turn = sessionTurns.get(sessionId) ?? 0;
    sessionTurns.set(sessionId, turn + 1);
    const response: SystemAgentChatResult = message
      ? message.toLowerCase().includes("channel")
        ? {
            sessionId,
            reply: "I can help with that.\n\nChoose a channel to continue.",
            action: "none",
            question: channelQuestion,
          }
        : {
            sessionId,
            reply: `I checked the mock system. Everything looks healthy.\n\nThat was demo turn ${turn}.`,
            action: "none",
          }
      : {
          sessionId,
          reply:
            "Hi — I’m OpenClaw, your system caretaker.\n\nAsk me about setup, channels, or recent changes.",
          action: "none",
        };
    window.setTimeout(() => respond(response), message === undefined ? 0 : 600);
  });
}

export function createControlUiPreviewInitScript(): string {
  return `(() => { const __name = (target) => target; (${installControlUiPreview.toString()})(); })();`;
}
