// Gateway known-weak credential guard.
// Rejects published placeholder auth values before the gateway starts.
import type { ResolvedGatewayAuth } from "./auth-resolve.js";

const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS = [
  "change-me-to-a-long-random-token",
  "change-me-now",
] as const;

const KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS = ["change-me-to-a-strong-password"] as const;

/**
 * Placeholder credentials that have ever shipped in `.env.example` or been
 * used as copy-paste examples in onboarding docs. If any of these ever
 * becomes the resolved gateway credential, reject it. The operator almost
 * certainly copied an example file verbatim without replacing the sentinel,
 * which would otherwise leave the gateway protected by a publicly-known
 * credential.
 */
const KNOWN_WEAK_GATEWAY_TOKENS: ReadonlySet<string> = new Set(
  KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS,
);

const KNOWN_WEAK_GATEWAY_PASSWORDS: ReadonlySet<string> = new Set(
  KNOWN_WEAK_GATEWAY_PASSWORD_PLACEHOLDERS,
);

/** Known non-secret values left by blank input or JavaScript string coercion. */
export function isInvalidGatewayToken(value: unknown): boolean {
  return typeof value === "string" && ["", "undefined", "null"].includes(value.trim());
}

export function assertGatewayAuthNotKnownWeak(auth: ResolvedGatewayAuth, rawToken?: unknown): void {
  if (auth.mode === "token") {
    // Token/password checks stay separate because auth mode is exclusive and
    // error text should name the credential the operator must rotate.
    const token = auth.token ?? rawToken;
    if (
      isInvalidGatewayToken(token) ||
      (typeof token === "string" && KNOWN_WEAK_GATEWAY_TOKENS.has(token.trim()))
    ) {
      throw new Error(
        "Invalid config: gateway auth token is blank, a published example placeholder, or the literal string undefined/null. " +
          "Generate a real secret (for example, `openssl rand -hex 32`) and update gateway.auth.token or its external source. " +
          "For blank or undefined/null inline tokens, `openclaw doctor --fix --generate-gateway-token` can generate one.",
      );
    }
    return;
  }
  if (auth.mode === "password") {
    const password = auth.password?.trim() ?? "";
    if (password && KNOWN_WEAK_GATEWAY_PASSWORDS.has(password)) {
      throw new Error(
        "Invalid config: gateway auth password is set to the example placeholder " +
          "from .env.example. Choose a real password and set OPENCLAW_GATEWAY_PASSWORD " +
          "or gateway.auth.password before starting the gateway.",
      );
    }
  }
}
