import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsInvokeParams,
  type ToolsInvokeResult,
} from "../protocol/index.js";
import { invokeGatewayTool } from "../tools-invoke-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveRpcErrorCode(params: {
  type: "invalid_request" | "not_found" | "tool_call_blocked" | "tool_error";
  requiresApproval?: boolean;
}): string {
  if (params.requiresApproval) {
    return "requires_approval";
  }
  switch (params.type) {
    case "invalid_request":
      return "validation_error";
    case "not_found":
      return "not_found";
    case "tool_call_blocked":
      return "forbidden";
    case "tool_error":
      return "internal_error";
  }
  return "internal_error";
}

export const toolsInvokeHandlers: GatewayRequestHandlers = {
  "tools.invoke": async ({ params, client, respond, context }) => {
    if (!validateToolsInvokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.invoke params: ${formatValidationErrors(validateToolsInvokeParams.errors)}`,
        ),
      );
      return;
    }
    const requestedToolName = normalizeOptionalString(params.name);
    if (!requestedToolName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tools.invoke params: name required"),
      );
      return;
    }

    const outcome = await invokeGatewayTool({
      cfg: context.getRuntimeConfig(),
      input: params,
      senderIsOwner: Boolean(client?.connect.scopes?.includes(ADMIN_SCOPE)),
      toolCallIdPrefix: "rpc",
      approvalMode: params.confirm === true ? "request" : "report",
    });

    if (outcome.ok) {
      const payload: ToolsInvokeResult = {
        ok: true,
        toolName: outcome.toolName,
        output: outcome.result,
        source: outcome.source,
      };
      respond(true, payload, undefined);
      return;
    }

    const payload: ToolsInvokeResult = {
      ok: false,
      toolName: outcome.toolName || requestedToolName,
      ...(outcome.error.requiresApproval ? { requiresApproval: true } : {}),
      error: {
        code: resolveRpcErrorCode(outcome.error),
        message: outcome.error.message,
      },
    };
    respond(true, payload, undefined);
  },
};
