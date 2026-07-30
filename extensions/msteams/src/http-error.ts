// Msteams plugin module implements http error behavior.
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";

export async function createMSTeamsHttpError(
  response: Response,
  label: string,
  options?: { statusPrefix?: string },
): Promise<Error> {
  return await createProviderHttpError(response, label, options);
}
