import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginMigrationProvider } from "../../plugins/migration-provider-runtime.js";
import type {
  MigrationPlan,
  MigrationProviderPlugin,
  ProviderAuthMethod,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { buildMigrationContext } from "../migrate/context.js";
import { applyMigrationItemSelection } from "../migrate/item-selection.js";

type ImportedProviderCredential = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth" | "token";
  configUpdated: boolean;
};

type ProviderCredentialImportResult = ImportedProviderCredential | { unavailableReason: string };

/** Import one provider-owned credential item before starting interactive login. */
export async function tryImportProviderCredential(params: {
  method: ProviderAuthMethod;
  config: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  credentialOnly?: boolean;
  signal?: AbortSignal;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<ProviderCredentialImportResult | undefined> {
  const spec = params.method.credentialImport;
  if (!spec) {
    return undefined;
  }
  params.signal?.throwIfAborted();
  const migrationProvider: MigrationProviderPlugin | undefined = resolvePluginMigrationProvider({
    providerId: spec.migrationProviderId,
    cfg: params.config,
  });
  if (!migrationProvider) {
    return undefined;
  }
  const context = buildMigrationContext({
    targetAgentId: params.agentId,
    itemKinds: ["auth"],
    includeSecrets: true,
    configOverride: params.config,
    providerOptions: {
      allowKeychainPrompt: true,
      credentialKind: spec.credentialKind,
      ...(params.credentialOnly ? { configPatchMode: "none" } : {}),
    },
    runtime: params.runtime,
  });
  if (params.signal) {
    context.signal = params.signal;
  }
  const plan: MigrationPlan = await migrationProvider.plan(context);
  const candidate = plan.items.find(
    (item) =>
      item.id === spec.itemId &&
      item.status === "planned" &&
      item.details?.credentialKind === spec.credentialKind,
  );
  if (!candidate) {
    const unavailable = plan.items.find(
      (item) =>
        item.id === spec.itemId &&
        item.status === "skipped" &&
        item.details?.credentialImportUnavailable === true,
    );
    if (unavailable?.message) {
      return { unavailableReason: unavailable.message };
    }
    return undefined;
  }
  await params.beforePersistentEffect?.();
  params.signal?.throwIfAborted();
  const result = await migrationProvider.apply(
    context,
    applyMigrationItemSelection(plan, [spec.itemId]),
  );
  const imported = result.items.find(
    (item) => item.id === spec.itemId && item.status === "migrated",
  );
  if (!imported) {
    throw new Error(
      "The existing provider credential changed during import. Start the sign-in again.",
    );
  }
  const profileId = imported.details?.profileId;
  const provider = imported.details?.provider;
  const credentialKind = imported.details?.credentialKind;
  const mode =
    credentialKind === "api_key" || credentialKind === "oauth" || credentialKind === "token"
      ? credentialKind
      : undefined;
  if (
    typeof profileId !== "string" ||
    !profileId.trim() ||
    typeof provider !== "string" ||
    !provider.trim() ||
    mode !== spec.credentialKind
  ) {
    throw new Error(
      "The existing provider credential changed during import. Start the sign-in again.",
    );
  }
  return {
    profileId: profileId.trim(),
    provider: provider.trim(),
    mode,
    configUpdated: imported.details?.configUpdated === true,
  };
}
