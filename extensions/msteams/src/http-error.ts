import {
  createProviderHttpError,
  extractProviderErrorDetail,
} from "openclaw/plugin-sdk/provider-http";

export async function createMSTeamsHttpError(
  response: Response,
  label: string,
  options?: { statusPrefix?: string },
): Promise<Error> {
  return await createProviderHttpError(response, label, options);
}

export async function readMSTeamsHttpErrorDetail(
  response: Response,
  fallback: string,
): Promise<string> {
  return (await extractProviderErrorDetail(response).catch(() => undefined)) ?? fallback;
}
