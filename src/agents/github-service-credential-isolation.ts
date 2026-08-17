import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";

export type PreparedGitHubCredentialIsolation = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  excludedStoreNames: readonly string[];
  /** A login profile could restore a credential that this projection scrubs. */
  credentialScrubRequiresNonLoginShell: boolean;
}>;

/** Prepares child-process scrubbing without materializing the service credential. */
export function prepareGitHubCredentialIsolation(params: {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PreparedGitHubCredentialIsolation {
  const env = params.env ?? process.env;
  const credentialScrubEnv: Record<string, string> = {
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  };
  const previewToken =
    params.sourceConfig?.gateway?.controlUi?.github?.token ??
    params.config.gateway?.controlUi?.github?.token;
  const excludedStoreNames: string[] = [];
  let credentialScrubRequiresNonLoginShell = Boolean(
    readNonBlankString(env.GH_TOKEN) || readNonBlankString(env.GITHUB_TOKEN),
  );
  if (isSecretRef(previewToken)) {
    if (previewToken.source === "env" && isValidEnvSecretRefId(previewToken.id)) {
      credentialScrubEnv[previewToken.id] = "";
      credentialScrubRequiresNonLoginShell = true;
    } else if (previewToken.source === "store") {
      excludedStoreNames.push(previewToken.id);
      credentialScrubRequiresNonLoginShell = true;
    }
  }
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    excludedStoreNames: Object.freeze(excludedStoreNames),
    credentialScrubRequiresNonLoginShell,
  });
}
