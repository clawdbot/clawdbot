import type { OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { ProviderAuthResult } from "../../plugins/types.js";

export const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  accountId: "workspace-1",
  expires: 123,
};
export const authorized: ProviderAuthResult = {
  profiles: [{ profileId: "openai:ignored-shared-id", credential }],
};
