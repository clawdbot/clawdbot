import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveCodexSyntheticUsageAuthProfileId(params: {
  profileId: string | undefined;
  cfg: OpenClawConfig;
  agentDir?: string;
}): string | undefined {
  const normalizedProfileId = params.profileId?.trim();
  if (!normalizedProfileId) {
    return undefined;
  }
  try {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
      config: params.cfg,
      readOnly: true,
      syncExternalCli: false,
    });
    const credential = store.profiles[normalizedProfileId];
    if (!credential) {
      return undefined;
    }
    const credentialProvider = normalizeOptionalLowercaseString(credential.provider);
    const resolvedProvider = resolveProviderIdForAuth(credential.provider, { config: params.cfg });
    return resolvedProvider === "openai" ||
      credentialProvider === "openai-codex" ||
      credentialProvider === "codex-cli"
      ? normalizedProfileId
      : undefined;
  } catch {
    return undefined;
  }
}
