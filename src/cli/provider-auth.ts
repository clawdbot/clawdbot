import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { loginWeb } from "../provider-web.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../providers/plugins/index.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ProviderAuthOptions = {
  provider?: string;
  account?: string;
  verbose?: boolean;
};

function normalizeLoginProvider(raw?: string): "whatsapp" | "web" {
  const value = String(raw ?? "whatsapp")
    .trim()
    .toLowerCase();
  if (value === "whatsapp" || value === "web") return value;
  throw new Error(`Unsupported provider: ${value}`);
}

export async function runProviderLogin(
  opts: ProviderAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const provider = normalizeLoginProvider(opts.provider);
  // Auth-only flow: do not mutate provider config here.
  setVerbose(Boolean(opts.verbose));
  await loginWeb(
    Boolean(opts.verbose),
    provider,
    undefined,
    runtime,
    opts.account,
  );
}

export async function runProviderLogout(
  opts: ProviderAuthOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const providerInput = opts.provider ?? "whatsapp";
  const providerId = normalizeProviderId(providerInput);
  if (!providerId) {
    throw new Error(`Unsupported provider: ${providerInput}`);
  }
  const plugin = getProviderPlugin(providerId);
  if (!plugin?.gateway?.logoutAccount) {
    throw new Error(`Provider ${providerId} does not support logout`);
  }
  // Auth-only flow: resolve account + clear session state only.
  const cfg = loadConfig();
  const accountId =
    opts.account?.trim() ||
    plugin.config.defaultAccountId?.(cfg) ||
    plugin.config.listAccountIds(cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = plugin.config.resolveAccount(cfg, accountId);
  await plugin.gateway.logoutAccount({
    cfg,
    accountId,
    account,
    runtime,
  });
}
