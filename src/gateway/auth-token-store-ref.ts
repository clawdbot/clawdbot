/** Store-backed SecretRef provisioning for gateway auth tokens setup generates itself. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { randomToken } from "../commands/random-token.js";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "../secrets/store/secret-store.js";

/** Store entry name for the gateway token; mirrors the documented env-var contract. */
const GATEWAY_AUTH_TOKEN_STORE_NAME = "OPENCLAW_GATEWAY_TOKEN";

const GATEWAY_AUTH_TOKEN_STORE_SCOPE = { kind: "team" } as const;

/** Minimal config shape needed to pick the store provider alias. */
type GatewayTokenStoreRefConfig = Parameters<typeof resolveDefaultSecretProviderAlias>[0];

function readStoredGatewayToken(): string | undefined {
  const existing = readSecretStoreValue({
    scope: GATEWAY_AUTH_TOKEN_STORE_SCOPE,
    name: GATEWAY_AUTH_TOKEN_STORE_NAME,
  });
  return existing.ok ? normalizeOptionalString(existing.value) : undefined;
}

/**
 * Provisions the gateway token in the secret store and returns the ref config points at.
 *
 * Omit `token` when setup has no value of its own: an existing store entry then wins so
 * reruns never rotate a token already paired with clients or a running service, and a
 * fresh one is minted otherwise. A supplied token always wins, which also migrates a
 * previously persisted plaintext token without invalidating it. The store write stays
 * ahead of the config write on purpose — a ref persisted without its value would leave
 * the gateway unauthenticatable, while an entry whose config write later fails is simply
 * picked up by the next run.
 */
export function provisionGatewayTokenStoreRef(params: {
  config: GatewayTokenStoreRefConfig;
  token?: string;
}): { ref: SecretRef; token: string } {
  const stored = params.token ? undefined : readStoredGatewayToken();
  const token = params.token ?? stored ?? randomToken();
  if (token !== stored) {
    writeSecretStoreEntry({
      scope: GATEWAY_AUTH_TOKEN_STORE_SCOPE,
      name: GATEWAY_AUTH_TOKEN_STORE_NAME,
      value: token,
      kind: "secret",
      updatedBy: "setup",
    });
  }
  return {
    ref: {
      source: "store",
      provider: resolveDefaultSecretProviderAlias(params.config, "store", {
        preferFirstProviderForSource: true,
      }),
      id: GATEWAY_AUTH_TOKEN_STORE_NAME,
    },
    token,
  };
}
