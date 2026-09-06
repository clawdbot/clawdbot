import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { FaceTimeRuntime, FaceTimeRuntimeStatus } from "./runtime.js";
import type { FaceTimeStaticStatus } from "./static-status.js";

const FaceTimeCallToolSchema = Type.Object(
  {
    action: stringEnum(["get_status", "check_readiness", "initiate_call", "end_call"] as const),
    handle: Type.Optional(
      Type.String({
        description: "Authorized owner FaceTime email or phone number",
        maxLength: 256,
      }),
    ),
    mode: Type.Optional(stringEnum(["audio", "video"] as const)),
    callUUID: Type.Optional(
      Type.String({ description: "Current call identity. Omit to end the current call." }),
    ),
  },
  { additionalProperties: false },
);

type FaceTimeToolRuntime = Pick<FaceTimeRuntime, "status" | "preflight" | "dial" | "hangup">;

export function resolveFaceTimeToolApproval(input: unknown) {
  const raw = asRecord(input);
  if (raw.action !== "initiate_call") {
    return undefined;
  }
  const handle = normalizeOptionalString(raw.handle);
  if (!handle) {
    return undefined;
  }
  const mode = raw.mode === "video" ? "video" : "audio";
  const allowedDecisions: Array<"allow-once" | "deny"> = ["allow-once", "deny"];
  return {
    requireApproval: {
      title: "Place FaceTime call",
      description: `Place a ${mode} FaceTime call to ${handle}.`,
      severity: "warning" as const,
      // A phone call is never safe to approve durably. Bind consent to this invocation.
      allowedDecisions,
      timeoutMs: 120_000,
    },
  };
}

function summarizeStatus(status: FaceTimeRuntimeStatus) {
  return {
    stageMeaning: "Internal carrier/model/native stages only; remote audibility is not measured.",
    enabled: status.enabled,
    helperConnected: status.helperConnected,
    helperProtocol: status.helperProtocol,
    helperTargets: status.helperTargets.map((target) => ({
      target: target.target,
      connected: target.connected,
      stale: target.stale,
      retryScheduled: target.retryScheduled,
    })),
    driverInstallPending: status.driverInstallPending,
    driverInstall: status.driverInstall,
    processOutputSuppressed: status.processOutputSuppressed,
    outboundCallPending: status.outboundCallPending,
    calls: status.calls.map((call) => ({
      callUUID: call.callUUID,
      phase: call.phase,
      carrierMode: call.carrierMode,
      modelMediaMode: call.modelMediaMode,
      handle: call.handle,
      realtimeActive: call.realtimeActive,
      audioReady: call.audioReady,
      processInputVerified: call.audioTransport?.processInputVerified === true,
      processOutputSuppressed: call.audioTransport?.processOutputSuppressed === true,
      lastRoutingError: call.lastRoutingError,
      carrierHangupPending: call.carrierHangupPending,
    })),
  };
}

export function createFaceTimeCallTool(params: {
  ensureRuntime: () => Promise<FaceTimeToolRuntime>;
  getStatus: () => Promise<FaceTimeRuntimeStatus | FaceTimeStaticStatus>;
}) {
  return {
    name: "facetime_call",
    label: "FaceTime Call",
    description:
      "Inspect FaceTime stages and manage calls for configured owner handles on this Mac.",
    parameters: FaceTimeCallToolSchema,
    async execute(_toolCallId: string, input: unknown) {
      const raw = asRecord(input);
      const action = normalizeOptionalString(raw.action);
      try {
        switch (action) {
          case "get_status":
            return json({
              ok: true,
              action,
              status: await params
                .getStatus()
                .then((status) => ("calls" in status ? summarizeStatus(status) : status)),
            });
          case "check_readiness": {
            const readiness = await params.getStatus();
            return json({
              ok: "calls" in readiness ? true : readiness.configValid,
              action,
              status: "calls" in readiness ? summarizeStatus(readiness) : readiness,
              note: "Reports internal static/runtime stages only; it does not prove remote audibility.",
            });
          }
          case "initiate_call": {
            const runtime = await params.ensureRuntime();
            const handle = normalizeOptionalString(raw.handle);
            if (!handle) {
              throw new Error("handle is required");
            }
            const status = await runtime.status();
            if (!status.helperConnected) {
              throw new Error("FaceTime helper is not connected");
            }
            if (status.driverInstallPending) {
              throw new Error("FaceTime audio driver installation is pending");
            }
            if (status.calls.length > 0 || status.outboundCallPending) {
              throw new Error("another FaceTime call is active or pending");
            }
            const mode = raw.mode === "audio" || raw.mode === "video" ? raw.mode : undefined;
            const result = await runtime.dial({
              handle,
              mode,
            });
            const { helper: _helper, ...publicResult } = result;
            return json({ ok: true, action, ...publicResult });
          }
          case "end_call": {
            const runtime = await params.ensureRuntime();
            const result = await runtime.hangup({
              callUUID: normalizeOptionalString(raw.callUUID),
            });
            return json({ ok: true, action, ...result });
          }
          default:
            throw new Error(
              "action must be get_status, check_readiness, initiate_call, or end_call",
            );
        }
      } catch (error) {
        return json({
          ok: false,
          action,
          error: formatErrorMessage(error),
        });
      }
    },
  };
}
