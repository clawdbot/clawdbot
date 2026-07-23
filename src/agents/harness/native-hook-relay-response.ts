export type NativeHookRelayResponseEvent =
  | "pre_tool_use"
  | "post_tool_use"
  | "permission_request"
  | "before_agent_finalize";

export type NativeHookRelayWireResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
  failureDisposition?: "failed" | "cancelled" | "timed_out";
};

export function renderCodexNativeHookNoopResponse(): NativeHookRelayWireResponse {
  return { stdout: "", stderr: "", exitCode: 0 };
}

export function renderCodexNativeHookPreToolUseBlockResponse(
  reason: string,
  failureDisposition?: NativeHookRelayWireResponse["failureDisposition"],
): NativeHookRelayWireResponse {
  return {
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
    stderr: "",
    exitCode: 0,
    ...(failureDisposition ? { failureDisposition } : {}),
  };
}

export function renderCodexNativeHookPermissionResponse(
  decision: "allow" | "deny",
  message?: string,
): NativeHookRelayWireResponse {
  return {
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          decision === "allow"
            ? { behavior: "allow" }
            : {
                behavior: "deny",
                message: message?.trim() || "Denied by OpenClaw",
              },
      },
    })}\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function renderCodexNativeHookUnavailableResponse(params: {
  event: NativeHookRelayResponseEvent;
  preToolUseUnavailable?: "noop";
  message: string;
}): NativeHookRelayWireResponse {
  if (params.event === "pre_tool_use") {
    return params.preToolUseUnavailable === "noop"
      ? renderCodexNativeHookNoopResponse()
      : renderCodexNativeHookPreToolUseBlockResponse(params.message);
  }
  if (params.event === "permission_request") {
    return renderCodexNativeHookPermissionResponse("deny", params.message);
  }
  return renderCodexNativeHookNoopResponse();
}
