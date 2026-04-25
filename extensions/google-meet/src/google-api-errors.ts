const REAUTH_HINT = "Re-run `openclaw googlemeet auth login` and store the refreshed oauth block.";

function scopeText(scopes: readonly string[]): string {
  return scopes.map((scope) => `\`${scope}\``).join(", ");
}

export async function googleApiError(params: {
  response: Response;
  detail: string;
  prefix: string;
  scopes?: readonly string[];
}): Promise<Error> {
  const scopeHint =
    params.scopes && params.scopes.length > 0
      ? ` Required OAuth scope: ${scopeText(params.scopes)}. ${REAUTH_HINT}`
      : "";
  return new Error(
    `${params.prefix} failed (${params.response.status}): ${params.detail}${scopeHint}`,
  );
}
