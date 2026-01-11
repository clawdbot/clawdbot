import { type Static, Type } from "@sinclair/typebox";

import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  ContinueCallSchema,
  EndCallSchema,
  GetCallStatusSchema,
  InitiateCallSchema,
  SpeakToUserSchema,
} from "./voice-call-schema.js";

const VoiceCallActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    ...InitiateCallSchema.properties,
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    ...ContinueCallSchema.properties,
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    ...SpeakToUserSchema.properties,
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    ...EndCallSchema.properties,
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    ...GetCallStatusSchema.properties,
  }),
]);

type VoiceCallAction = Static<typeof VoiceCallActionSchema>;

export function createVoiceCallTool(): AnyAgentTool {
  return {
    label: "Voice Call",
    name: "voice_call",
    description: `Make phone calls and have voice conversations.

Actions:
- initiate_call: Start a phone call. Returns callId for follow-up actions.
- continue_call: Speak a message and wait for user response.
- speak_to_user: Speak without waiting for response (use before long operations).
- end_call: Hang up the call.
- get_status: Check if a call is still active.`,

    parameters: VoiceCallActionSchema,

    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = (args.action as VoiceCallAction["action"]) ?? "get_status";

      try {
        switch (action) {
          case "initiate_call": {
            const message = readStringParam(args, "message", {
              required: true,
            });
            const to =
              typeof args.to === "string" && args.to.trim()
                ? args.to.trim()
                : undefined;
            const mode =
              args.mode === "notify" || args.mode === "conversation"
                ? args.mode
                : undefined;

            const res = await callGateway({
              method: "voicecall.initiate",
              params: { to, message, mode },
            });
            return jsonResult(res);
          }

          case "continue_call": {
            const callId = readStringParam(args, "callId", { required: true });
            const message = readStringParam(args, "message", {
              required: true,
            });
            const res = await callGateway({
              method: "voicecall.continue",
              params: { callId, message },
            });
            return jsonResult(res);
          }

          case "speak_to_user": {
            const callId = readStringParam(args, "callId", { required: true });
            const message = readStringParam(args, "message", {
              required: true,
            });
            const res = await callGateway({
              method: "voicecall.speak",
              params: { callId, message },
            });
            return jsonResult(res);
          }

          case "end_call": {
            const callId = readStringParam(args, "callId", { required: true });
            const res = await callGateway({
              method: "voicecall.end",
              params: { callId },
            });
            return jsonResult(res);
          }

          case "get_status": {
            const callId = readStringParam(args, "callId", { required: true });
            const res = await callGateway({
              method: "voicecall.status",
              params: { callId },
            });
            return jsonResult(res);
          }
        }
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
