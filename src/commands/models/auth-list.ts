/** Command helpers for listing saved model auth profiles. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay,
  type AuthProfileCredential,
  type AuthProfileStore,
  type ProfileUsageStats,
} from "../../agents/auth-profiles.js";
import { buildAuthProfileUnusableHint } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

type AuthProfileSummary = {
  id: string;
  provider: string;
  type: AuthProfileCredential["type"];
  label: string;
  email?: string;
  displayName?: string;
  expiresAt?: string;
  cooldownUntil?: string;
  disabledUntil?: string;
  cooldownReason?: ProfileUsageStats["cooldownReason"];
  cooldownClassification?: ProfileUsageStats["cooldownClassification"];
  disabledReason?: ProfileUsageStats["disabledReason"];
  recoveryHint?: string;
};

function resolveProviderFilter(rawProvider: string | undefined): {
  provider: string | undefined;
  externalCliProvider: string | undefined;
  matches: (profile: AuthProfileSummary) => boolean;
} {
  const provider = rawProvider?.trim() ? resolveProviderIdForAuth(rawProvider) : undefined;
  if (!provider) {
    return {
      provider: undefined,
      externalCliProvider: undefined,
      matches: () => true,
    };
  }
  return {
    provider,
    externalCliProvider: provider,
    matches: (profile) => profile.provider === provider,
  };
}

function formatTimestamp(value: number | undefined): string | undefined {
  return timestampMsToIsoString(value);
}

function resolveProfileExpiry(profile: AuthProfileCredential): string | undefined {
  return profile.type === "api_key" ? undefined : formatTimestamp(profile.expires);
}

function summarizeProfile(params: {
  cfg: Awaited<ReturnType<typeof loadModelsConfig>>;
  store: AuthProfileStore;
  profileId: string;
  profile: AuthProfileCredential;
  usage?: ProfileUsageStats;
}): AuthProfileSummary {
  const expiresAt = resolveProfileExpiry(params.profile);
  const cooldownUntil = formatTimestamp(params.usage?.cooldownUntil);
  const disabledUntil = formatTimestamp(params.usage?.disabledUntil);
  const disabledActive = Boolean(disabledUntil);
  const reason = disabledActive
    ? params.usage?.disabledReason
    : cooldownUntil
      ? params.usage?.cooldownReason
      : undefined;
  const recoveryHint =
    disabledUntil || cooldownUntil
      ? buildAuthProfileUnusableHint({
          kind: disabledActive ? "disabled" : "cooldown",
          reason,
          provider: params.profile.provider,
          profileId: params.profileId,
        })
      : undefined;
  return {
    id: params.profileId,
    provider: resolveProviderIdForAuth(params.profile.provider),
    type: params.profile.type,
    label: resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store: params.store,
      profileId: params.profileId,
    }),
    ...(params.profile.email ? { email: params.profile.email } : {}),
    ...(params.profile.displayName ? { displayName: params.profile.displayName } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(disabledUntil ? { disabledUntil } : {}),
    ...(params.usage?.cooldownReason ? { cooldownReason: params.usage.cooldownReason } : {}),
    ...(params.usage?.cooldownClassification
      ? { cooldownClassification: params.usage.cooldownClassification }
      : {}),
    ...(params.usage?.disabledReason ? { disabledReason: params.usage.disabledReason } : {}),
    ...(recoveryHint ? { recoveryHint } : {}),
  };
}

function formatProfileLine(profile: AuthProfileSummary): string {
  const details = [`${profile.provider}/${profile.type}`];
  if (profile.expiresAt) {
    details.push(`expires ${profile.expiresAt}`);
  }
  if (profile.cooldownUntil) {
    const diagnostic = profile.cooldownClassification ?? profile.cooldownReason;
    details.push(`cooldown${diagnostic ? `:${diagnostic}` : ""} until ${profile.cooldownUntil}`);
  }
  if (profile.disabledUntil) {
    details.push(
      `disabled${profile.disabledReason ? `:${profile.disabledReason}` : ""} until ${profile.disabledUntil}`,
    );
  }
  return `- ${profile.label} [${details.join("; ")}]${profile.recoveryHint ? ` — ${profile.recoveryHint}` : ""}`;
}

/** Lists auth profiles for the selected agent, optionally filtered by provider. */
export async function modelsAuthListCommand(
  opts: { provider?: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const cfg = await loadModelsConfig({ commandName: "models auth list", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "read" });
  const providerFilter = resolveProviderFilter(opts.provider);
  const store = ensureAuthProfileStore(
    agentDir,
    providerFilter.externalCliProvider
      ? {
          externalCli: externalCliDiscoveryForProviderAuth({
            cfg,
            provider: providerFilter.externalCliProvider,
          }),
        }
      : undefined,
  );
  const profiles = Object.entries(store.profiles)
    .map(([profileId, profile]) =>
      summarizeProfile({
        cfg,
        store,
        profileId,
        profile,
        usage: store.usageStats?.[profileId],
      }),
    )
    .filter((profile) => providerFilter.matches(profile))
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      agentDir: shortenHomePath(agentDir),
      authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
      provider: providerFilter.provider ?? null,
      profiles,
    });
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  if (providerFilter.provider) {
    runtime.log(`Provider: ${providerFilter.provider}`);
  }
  if (profiles.length === 0) {
    runtime.log("Profiles: (none)");
    return;
  }
  runtime.log("Profiles:");
  for (const profile of profiles) {
    runtime.log(formatProfileLine(profile));
  }
}
