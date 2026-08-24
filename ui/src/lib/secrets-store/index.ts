import type {
  SecretStoreEntry,
  SecretsStoreListResult,
  SecretsStoreMutationResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import { parseSecretStoreDotEnvText } from "../../../../src/secrets/store/dotenv.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";

export type SecretsStoreDraft = {
  name: string;
  value: string;
  kind: "secret" | "env";
  allowedHosts: string;
};

type SecretsStoreBulkEntry = Omit<SecretsStoreDraft, "allowedHosts">;

export type SecretsStoreState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  entries: SecretStoreEntry[];
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

export function createInitialSecretsStoreState(
  snapshot: Partial<Pick<SecretsStoreState, "client" | "connected">> = {},
): SecretsStoreState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    entries: [],
    loaded: false,
    loading: false,
    busy: false,
    error: null,
  };
}

async function requestSnapshot(client: GatewayBrowserClient): Promise<SecretStoreEntry[]> {
  const result = await client.request<SecretsStoreListResult>("secrets.store.list", {});
  return result.entries;
}

export async function loadSecretsStore(state: SecretsStoreState): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.loading) {
    return false;
  }
  state.loading = true;
  state.error = null;
  try {
    const entries = await requestSnapshot(client);
    if (state.client === client && state.connected) {
      state.entries = entries;
      state.loaded = true;
      return true;
    }
    return false;
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return false;
  } finally {
    if (state.client === client) {
      state.loading = false;
    }
  }
}

async function mutateAndReload(
  state: SecretsStoreState,
  mutate: (client: GatewayBrowserClient) => Promise<SecretsStoreMutationResult>,
): Promise<SecretsStoreMutationResult | null> {
  const client = state.client;
  if (!client || !state.connected || state.busy) {
    return null;
  }
  state.busy = true;
  state.error = null;
  let result: SecretsStoreMutationResult | null = null;
  let mutationError: unknown;
  try {
    result = await mutate(client);
  } catch (error) {
    mutationError = error;
  }
  try {
    const entries = await requestSnapshot(client);
    if (state.client === client && state.connected) {
      state.entries = entries;
      state.loaded = true;
    }
  } catch (error) {
    mutationError ??= error;
  } finally {
    if (state.client === client) {
      state.busy = false;
      state.error = mutationError ? formatUiError(mutationError) : null;
    }
  }
  return mutationError ? null : result;
}

export function setSecretsStoreEntry(
  state: SecretsStoreState,
  draft: SecretsStoreDraft,
): Promise<SecretsStoreMutationResult | null> {
  return mutateAndReload(state, (client) =>
    client.request<SecretsStoreMutationResult>("secrets.store.set", {
      name: draft.name,
      value: draft.value,
      kind: draft.kind,
      ...(draft.kind === "secret"
        ? {
            allowedHosts: draft.allowedHosts
              .split(/[\s,]+/u)
              .map((host) => host.trim())
              .filter(Boolean),
          }
        : {}),
    }),
  );
}

export function deleteSecretsStoreEntry(
  state: SecretsStoreState,
  name: string,
): Promise<SecretsStoreMutationResult | null> {
  return mutateAndReload(state, (client) =>
    client.request<SecretsStoreMutationResult>("secrets.store.delete", { name }),
  );
}

export function parseSecretsStoreBulkInput(
  raw: string,
  autoDetectSecrets: boolean,
): { entries: SecretsStoreBulkEntry[]; invalidNames: string[] } {
  const parsed = parseSecretStoreDotEnvText(raw);
  const invalidNames = Object.keys(parsed).filter((name) => !ENV_SECRET_REF_ID_RE.test(name));
  const entries: SecretsStoreBulkEntry[] = Object.entries(parsed).map(([name, value]) => ({
    name,
    value,
    kind: autoDetectSecrets && isSensitiveEnvName(name) ? "secret" : "env",
  }));
  return { entries, invalidNames };
}

export async function bulkSetSecretsStoreEntries(
  state: SecretsStoreState,
  entries: readonly SecretsStoreBulkEntry[],
): Promise<{ saved: number; warningCount: number } | null> {
  const client = state.client;
  if (!client || !state.connected || state.busy || entries.length === 0) {
    return null;
  }
  state.busy = true;
  state.error = null;
  let saved = 0;
  let warningCount = 0;
  let mutationError: unknown;
  try {
    for (const entry of entries) {
      const result = await client.request<SecretsStoreMutationResult>("secrets.store.set", entry);
      saved += 1;
      warningCount = Math.max(warningCount, result.warningCount ?? 0);
      const snapshot = await requestSnapshot(client);
      if (state.client === client && state.connected) {
        state.entries = snapshot;
        state.loaded = true;
      }
    }
  } catch (error) {
    mutationError = new Error(
      t("secretsStore.partial", {
        saved: String(saved),
        total: String(entries.length),
        error: formatUiError(error),
      }),
    );
  }
  try {
    if (mutationError) {
      const snapshot = await requestSnapshot(client);
      if (state.client === client && state.connected) {
        state.entries = snapshot;
        state.loaded = true;
      }
    }
  } catch (error) {
    mutationError ??= error;
  } finally {
    if (state.client === client) {
      state.busy = false;
      state.error = mutationError ? formatUiError(mutationError) : null;
    }
  }
  return mutationError ? null : { saved, warningCount };
}
