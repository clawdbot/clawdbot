import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function jsonToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function unknownToolActionResult(action: unknown) {
  return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}

export function toolExecutionErrorResult(error: unknown) {
  return jsonToolResult({ error: formatErrorMessage(error) });
}
