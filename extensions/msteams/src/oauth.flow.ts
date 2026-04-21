import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_CALLBACK_PATH,
  MSTEAMS_OAUTH_CALLBACK_PORT,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsAuthEndpoint,
} from "./oauth.shared.js";

export function shouldUseManualOAuthFlow(isRemote: boolean): boolean {
  return isRemote || isWSL2Sync();
}

export function generatePkce(): { verifier: string; challenge: string } {
  return generateHexPkceVerifierChallenge();
}

export { generateOAuthState };

export function buildMSTeamsAuthUrl(params: {
  tenantId: string;
  clientId: string;
  challenge: string;
  /** Opaque CSRF state token — must NOT be the PKCE verifier. */
  state: string;
  scopes?: readonly string[];
}): string {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const endpoint = buildMSTeamsAuthEndpoint(params.tenantId);
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
    scope: scopes.join(" "),
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    prompt: "consent",
  });
  return `${endpoint}?${query.toString()}`;
}

export function parseCallbackInput(
  input: string,
  // Kept in the signature for API symmetry with the caller's CSRF verify step.
  // The caller compares the parsed `state` against the expected value.
  _expectedState: string,
): { code: string; state: string } | { error: string } {
  return parseOAuthCallbackInput(input, {
    missingState: "Missing 'state' parameter in URL. Paste the full redirect URL.",
    invalidInput:
      "Paste the full redirect URL (including code and state parameters), not just the authorization code.",
  });
}

export async function waitForLocalCallback(params: {
  expectedState: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}): Promise<{ code: string; state: string }> {
  return await waitForLocalOAuthCallback({
    expectedState: params.expectedState,
    timeoutMs: params.timeoutMs,
    port: MSTEAMS_OAUTH_CALLBACK_PORT,
    callbackPath: MSTEAMS_OAUTH_CALLBACK_PATH,
    redirectUri: MSTEAMS_OAUTH_REDIRECT_URI,
    successTitle: "MSTeams Delegated OAuth complete",
    progressMessage: `Waiting for OAuth callback on ${MSTEAMS_OAUTH_REDIRECT_URI}...`,
    onProgress: params.onProgress,
  });
}
