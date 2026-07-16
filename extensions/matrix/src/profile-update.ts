import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { updateMatrixOwnProfile } from "./matrix/actions/profile.js";
import { updateMatrixAccountConfig, resolveMatrixConfigPath } from "./matrix/config-update.js";
import { getMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export type MatrixProfileUpdateResult = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  profile: {
    displayNameUpdated: boolean;
    avatarUpdated: boolean;
    resolvedAvatarUrl: string | null;
    uploadedAvatarSource: "http" | "path" | null;
    convertedAvatarFromHttp: boolean;
  };
  configPath: string;
};

export async function applyMatrixProfileUpdate(params: {
  cfg?: CoreConfig;
  account?: string;
  displayName?: string;
  avatarUrl?: string;
  avatarPath?: string;
  mediaLocalRoots?: readonly string[];
}): Promise<MatrixProfileUpdateResult> {
  const runtime = getMatrixRuntime();
  const persistedCfg = runtime.config.loadConfig() as CoreConfig;
  const accountId = normalizeAccountId(params.account);
  const displayName = params.displayName?.trim() || null;
  const avatarUrl = params.avatarUrl?.trim() || null;
  const avatarPath = params.avatarPath?.trim() || null;
  if (!displayName && !avatarUrl && !avatarPath) {
    throw new Error("Provide name/displayName and/or avatarUrl/avatarPath.");
  }

  const synced = await updateMatrixOwnProfile({
    cfg: params.cfg,
    accountId,
    displayName: displayName ?? undefined,
    avatarUrl: avatarUrl ?? undefined,
    avatarPath: avatarPath ?? undefined,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const persistedAvatarUrl =
    synced.uploadedAvatarSource && synced.resolvedAvatarUrl ? synced.resolvedAvatarUrl : avatarUrl;
  const updated = updateMatrixAccountConfig(persistedCfg, accountId, {
    name: displayName ?? undefined,
    avatarUrl: persistedAvatarUrl ?? undefined,
  });
  await runtime.config.writeConfigFile(updated as never);

  return {
    accountId,
    displayName,
    avatarUrl: persistedAvatarUrl ?? null,
    profile: {
      displayNameUpdated: synced.displayNameUpdated,
      avatarUpdated: synced.avatarUpdated,
      resolvedAvatarUrl: synced.resolvedAvatarUrl,
      uploadedAvatarSource: synced.uploadedAvatarSource,
      convertedAvatarFromHttp: synced.convertedAvatarFromHttp,
    },
    configPath: resolveMatrixConfigPath(updated, accountId),
  };
}
