import { isJsonObject, type JsonObject } from "./protocol.js";

export function isCodexOutputSchemaUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  let payload: unknown;
  try {
    // Codex app-server surfaces the backend response body as the terminal error message.
    payload = JSON.parse(error.message);
  } catch {
    return false;
  }
  const failure = isJsonObject(payload) && isJsonObject(payload.error) ? payload.error : payload;
  return (
    isJsonObject(failure) &&
    failure.code === "invalid_json_schema" &&
    failure.param === "text.format.schema"
  );
}

export function buildOutputSchemaFallbackPrompt(outputSchema: JsonObject): string {
  return [
    "Return one valid JSON value matching this JSON Schema. Do not include markdown or commentary.",
    JSON.stringify(outputSchema),
  ].join("\n\n");
}
