type AnthropicAuthModel = {
  provider?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
};

export function usesFoundryBearerAuth(model: AnthropicAuthModel): boolean {
  return (
    model.provider === "microsoft-foundry" &&
    (model.authHeader === true || hasBearerAuthorizationHeader(model.headers))
  );
}

function hasBearerAuthorizationHeader(headers?: Record<string, string>): boolean {
  if (!headers) {
    return false;
  }
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === "authorization" && /^bearer\s+\S+/i.test(value.trim()),
  );
}

export function omitFoundryBearerCredentialHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "api-key") {
      continue;
    }
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
