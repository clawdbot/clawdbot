/** Codex native-login discovery descriptor for static model and auth surfaces. */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCodexNativeAuth } from "./src/app-server/native-auth.js";

// "Codex reports no login" is a probe outcome, not a cache miss. Store the outcome in a
// wrapper so a logged-out host does not re-spawn the 3s `codex login status` probe on every
// synthetic-auth pass; `resolveSyntheticAuth` is a synchronous provider-plugin contract.
const nativeAuthByConfig = new WeakMap<
  object,
  { auth: ReturnType<typeof resolveCodexNativeAuth> }
>();

function resolveCodexSyntheticAuth(config: object | undefined) {
  if (!config) {
    return undefined;
  }
  let probed = nativeAuthByConfig.get(config);
  if (!probed) {
    probed = { auth: resolveCodexNativeAuth() };
    nativeAuthByConfig.set(config, probed);
  }
  return probed.auth ? { ...probed.auth, runtime: "codex" } : undefined;
}

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  aliases: ["openai"],
  label: "Codex",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ config, provider }) =>
    provider === "codex" || provider === "openai" ? resolveCodexSyntheticAuth(config) : undefined,
};

export default codexProviderDiscovery;
