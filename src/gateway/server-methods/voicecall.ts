import { z } from "zod";
import { getVoiceCallRuntime } from "../../voice-call/runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const InitiateParamsSchema = z.object({
  to: z.string().optional(),
  message: z.string().min(1),
  mode: z.enum(["notify", "conversation"]).optional(),
});

const CallMessageParamsSchema = z.object({
  callId: z.string().min(1),
  message: z.string().min(1),
});

const EndParamsSchema = z.object({
  callId: z.string().min(1),
});

const StatusParamsSchema = z.object({
  callId: z.string().min(1),
});

export const voicecallHandlers: GatewayRequestHandlers = {
  "voicecall.initiate": async ({ params, respond }) => {
    const parsed = InitiateParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid params"),
      );
      return;
    }

    const rt = await getVoiceCallRuntime();
    const to = parsed.data.to ?? rt.config.toNumber;
    if (!to) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Missing 'to' and no voiceCall.toNumber configured",
        ),
      );
      return;
    }

    const result = await rt.manager.initiateCall(to, undefined, {
      message: parsed.data.message,
      mode: parsed.data.mode,
    });
    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error || "initiate failed"),
      );
      return;
    }

    // NOTE: The initial message is not spoken here because the call hasn't been
    // answered yet. The agent should use voicecall.continue after receiving the
    // call.answered webhook event to speak the first message.
    respond(true, {
      callId: result.callId,
      initiated: true,
    });
  },

  "voicecall.continue": async ({ params, respond }) => {
    const parsed = CallMessageParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid params"),
      );
      return;
    }

    const rt = await getVoiceCallRuntime();
    const result = await rt.manager.continueCall(
      parsed.data.callId,
      parsed.data.message,
    );
    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error || "continue failed"),
      );
      return;
    }

    respond(true, { success: true, transcript: result.transcript });
  },

  "voicecall.speak": async ({ params, respond }) => {
    const parsed = CallMessageParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid params"),
      );
      return;
    }

    const rt = await getVoiceCallRuntime();
    const result = await rt.manager.speak(
      parsed.data.callId,
      parsed.data.message,
    );
    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error || "speak failed"),
      );
      return;
    }

    respond(true, { success: true });
  },

  "voicecall.end": async ({ params, respond }) => {
    const parsed = EndParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid params"),
      );
      return;
    }

    const rt = await getVoiceCallRuntime();
    const result = await rt.manager.endCall(parsed.data.callId);
    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error || "end failed"),
      );
      return;
    }

    respond(true, { success: true });
  },

  "voicecall.status": async ({ params, respond }) => {
    const parsed = StatusParamsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid params"),
      );
      return;
    }

    const rt = await getVoiceCallRuntime();
    const call = rt.manager.getCall(parsed.data.callId);
    if (!call) {
      respond(true, { found: false });
      return;
    }

    respond(true, { found: true, call });
  },
};
