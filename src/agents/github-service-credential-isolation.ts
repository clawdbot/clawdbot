import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";

export type PreparedGitHubCredentialIsolation = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  excludedStoreNames: readonly string[];
}>;

/** Prepares child-process scrubbing without materializing the service credential. */
export function prepareGitHubCredentialIsolation(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): PreparedGitHubCredentialIsolation {
  const credentialScrubEnv: Record<string, string> = {
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
  const previewToken =
    params.sourceConfig?.gateway?.controlUi?.github?.token ??
    params.config.gateway?.controlUi?.github?.token;
  const excludedStoreNames: string[] = [];
  if (isSecretRef(previewToken)) {
    if (previewToken.source === "env" && isValidEnvSecretRefId(previewToken.id)) {
      credentialScrubEnv[previewToken.id] = "";
    } else if (previewToken.source === "store") {
      credentialScrubEnv[previewToken.id] = "";
      excludedStoreNames.push(previewToken.id);
    }
  }
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    excludedStoreNames: Object.freeze(excludedStoreNames),
  });
}
