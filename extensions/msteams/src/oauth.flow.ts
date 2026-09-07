// Msteams plugin module implements oauth.flow behavior.
import { isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsAuthEndpoint,
} from "./oauth.shared.js";

export function shouldUseManualOAuthFlow(isRemote: boolean): boolean {
  return isRemote || isWSL2Sync();
}

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
