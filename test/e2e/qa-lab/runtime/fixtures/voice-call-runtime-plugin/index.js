import fs from "node:fs";

const append = (filePath, value) => {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
};

export default {
  id: "qa-voice-call-runtime",
  register(api) {
    api.registerRealtimeVoiceProvider({
      id: "qa-voice-call-realtime",
      label: "QA Voice Call Realtime",
      isConfigured: () => true,
      createBrowserSession() {
        throw new Error("Voice Call fixture is bridge-only");
      },
      createBridge(request) {
        append(process.env.OPENCLAW_QA_VOICE_BRIDGE_CALLS_PATH, {
          instructions: request.instructions,
          tools: request.tools?.map((tool) => tool.name) ?? [],
        });
        let connected = false;
        return {
          supportsToolResultContinuation: true,
          async connect() {
            connected = true;
            request.onReady?.();
            request.onTranscript?.("user", "Caller partial transcript context", false);
            setTimeout(() => {
              request.onToolCall?.({
                itemId: "qa-consult-item",
                callId: "qa-consult-call",
                name: "openclaw_agent_consult",
                args: {
                  question: "Use the embedded agent context to identify the caller request.",
                  context: "Realtime provider context marker: VOICE-CONSULT-42",
                },
              });
            }, 10);
          },
          sendAudio() {},
          setMediaTimestamp() {},
          submitToolResult(callId, result, options) {
            append(process.env.OPENCLAW_QA_VOICE_TOOL_RESULTS_PATH, { callId, result, options });
          },
          acknowledgeMark() {},
          close() {
            connected = false;
          },
          isConnected() {
            return connected;
          },
          triggerGreeting() {},
        };
      },
    });
    api.registerGatewayMethod("qa.voiceCall.streamSession", async ({ params, respond }) => {
      const runtime = globalThis[Symbol.for("openclaw.voice-call.runtime")];
      const callId = typeof params?.callId === "string" ? params.callId : "";
      const call = runtime?.manager?.getCall?.(callId);
      const issue = runtime?.manager?.streamSessionIssuer;
      if (!runtime || !call || typeof issue !== "function" || !call.providerCallId) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Voice Call runtime stream issuer unavailable",
        });
        return;
      }
      const session = issue({
        providerName: "twilio",
        callId,
        from: call.from,
        to: call.to,
        direction: call.direction,
      });
      respond(true, {
        ...session,
        providerCallId: call.providerCallId,
        webhookUrl: runtime.webhookUrl,
      });
    });
  },
};
