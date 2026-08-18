export const CF_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export type CloudflareAccessCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

/** Build only the two headers Cloudflare Access defines for service-token auth. */
export function buildCloudflareAccessHeaders(
  credentials: CloudflareAccessCredentials,
): Record<string, string> {
  return {
    [CF_ACCESS_CLIENT_ID_HEADER]: credentials.clientId,
    [CF_ACCESS_CLIENT_SECRET_HEADER]: credentials.clientSecret,
  };
}
