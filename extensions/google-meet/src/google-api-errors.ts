// Google Meet plugin module implements google api errors behavior.
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";

const REAUTH_HINT = "Re-run `openclaw googlemeet auth login` and store the refreshed oauth block.";
const GOOGLE_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

function scopeText(scopes: readonly string[]): string {
  return scopes.map((scope) => `\`${scope}\``).join(", ");
}

export async function readGoogleApiErrorDetail(response: Response): Promise<string> {
  return await readResponseTextLimited(response, GOOGLE_API_ERROR_BODY_LIMIT_BYTES);
}

export async function googleApiError(params: {
  response: Response;
  prefix: string;
  scopes?: readonly string[];
}): Promise<Error> {
  const detail = await readGoogleApiErrorDetail(params.response);
  const scopeHint =
    params.scopes && params.scopes.length > 0
      ? ` Required OAuth scope: ${scopeText(params.scopes)}. ${REAUTH_HINT}`
      : "";
  return new Error(`${params.prefix} failed (${params.response.status}): ${detail}${scopeHint}`);
}
