import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { resolveOAuthClientConfig } from "./oauth.credentials.js";
import { AUTH_URL, REDIRECT_URI, SCOPES } from "./oauth.shared.js";

export { generateOAuthState };

export function shouldUseManualOAuthFlow(isRemote: boolean): boolean {
  return isRemote || isWSL2Sync();
}

export function generatePkce(): { verifier: string; challenge: string } {
  return generateHexPkceVerifierChallenge();
}

export function buildAuthUrl(challenge: string, state: string): string {
  const { clientId } = resolveOAuthClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function parseCallbackInput(
  input: string,
): { code: string; state: string } | { error: string } {
  return parseOAuthCallbackInput(input, {
    missingState: "Missing 'state' parameter. Paste the full URL.",
    invalidInput: "Paste the full redirect URL, not just the code.",
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
    port: 8085,
    callbackPath: "/oauth2callback",
    redirectUri: REDIRECT_URI,
    successTitle: "Gemini CLI OAuth complete",
    progressMessage: `Waiting for OAuth callback on ${REDIRECT_URI}…`,
    onProgress: params.onProgress,
  });
}
