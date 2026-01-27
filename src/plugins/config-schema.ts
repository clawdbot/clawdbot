import type { MoltbotPluginConfigSchema } from "./types.js";

type Issue = { path: Array<string | number>; message: string };

type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

function error(message: string): SafeParseResult {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

export function emptyPluginConfigSchema(): MoltbotPluginConfigSchema {
  return {
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}
