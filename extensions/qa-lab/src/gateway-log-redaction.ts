const QA_GATEWAY_DEBUG_SECRET_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_API_KEYS",
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "VOYAGE_API_KEY",
]);

export function redactQaGatewayDebugText(text: string) {
  let redacted = text;
  for (const envVar of QA_GATEWAY_DEBUG_SECRET_ENV_VARS) {
    const escapedEnvVar = envVar.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(
      new RegExp(`\\b(${escapedEnvVar})(\\s*[=:]\\s*)([^\\s"';,]+|"[^"]*"|'[^']*')`, "g"),
      `$1$2<redacted>`,
    );
    redacted = redacted.replace(
      new RegExp(`("${escapedEnvVar}"\\s*:\\s*)"[^"]*"`, "g"),
      `$1"<redacted>"`,
    );
  }
  return redacted
    .replaceAll(/\bsk-ant-oat01-[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replaceAll(/\bBearer\s+[^\s"'<>]{8,}/gi, "Bearer <redacted>")
    .replaceAll(/([?#&]token=)[^&\s]+/gi, "$1<redacted>");
}

export function formatQaGatewayLogsForError(logs: string) {
  const sanitized = redactQaGatewayDebugText(logs).trim();
  return sanitized.length > 0 ? `\nGateway logs:\n${sanitized}` : "";
}
