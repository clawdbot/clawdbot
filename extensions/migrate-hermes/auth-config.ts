import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { applyAuthProfileConfig, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";

export type HermesAuthProfileConfig = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth" | "token";
  email?: string;
  displayName?: string;
};

export type HermesAuthConfigApplyResult = "configured" | "conflict" | "unavailable";

class HermesAuthConfigConflict extends Error {}

function existingProfileIsCompatible(
  existing: NonNullable<NonNullable<OpenClawConfig["auth"]>["profiles"]>[string],
  profile: HermesAuthProfileConfig,
): boolean {
  if (existing.provider !== profile.provider || existing.mode !== profile.mode) {
    return false;
  }
  if (existing.email && profile.email && existing.email !== profile.email) {
    return false;
  }
  return true;
}

export function hasAuthProfileConfigConflict(
  config: OpenClawConfig,
  profile: HermesAuthProfileConfig,
  overwrite: boolean,
): boolean {
  if (overwrite) {
    return false;
  }
  const existing = config.auth?.profiles?.[profile.profileId];
  return Boolean(existing && !existingProfileIsCompatible(existing, profile));
}

function replaceConfigDraft(draft: OpenClawConfig, next: OpenClawConfig): void {
  for (const key of Object.keys(draft) as Array<keyof OpenClawConfig>) {
    delete draft[key];
  }
  Object.assign(draft, next);
}

export function hasCurrentAuthProfileConfigConflict(
  ctx: MigrationProviderContext,
  profile: HermesAuthProfileConfig,
): boolean {
  let config = ctx.config;
  try {
    config = (ctx.runtime?.config?.current?.() as OpenClawConfig | undefined) ?? config;
  } catch {
    // Fall back to the planning snapshot; apply still rechecks inside mutate.
  }
  return hasAuthProfileConfigConflict(config, profile, Boolean(ctx.overwrite));
}

export async function applyAuthProfileConfigWithConflictCheck(params: {
  ctx: MigrationProviderContext;
  profile: HermesAuthProfileConfig;
  applyConfigPatch?: (config: OpenClawConfig) => OpenClawConfig;
}): Promise<HermesAuthConfigApplyResult> {
  const configApi = params.ctx.runtime?.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return "unavailable";
  }
  try {
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        let next = draft;
        if (params.applyConfigPatch) {
          next = params.applyConfigPatch(next);
        }
        if (hasAuthProfileConfigConflict(next, params.profile, Boolean(params.ctx.overwrite))) {
          throw new HermesAuthConfigConflict();
        }
        next = applyAuthProfileConfig(next, {
          profileId: params.profile.profileId,
          provider: params.profile.provider,
          mode: params.profile.mode,
          ...(params.profile.email ? { email: params.profile.email } : {}),
          ...(params.profile.displayName ? { displayName: params.profile.displayName } : {}),
          preferProfileFirst: false,
        });
        replaceConfigDraft(draft, next);
      },
    });
    return "configured";
  } catch (error) {
    return error instanceof HermesAuthConfigConflict ? "conflict" : "unavailable";
  }
}
