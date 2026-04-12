import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

export function listBundledChannelIdsWithPersistedAuthState(): string[] {
  return listBundledChannelIdsForPackageState("persistedAuthState");
}

export function hasBundledChannelPersistedAuthState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return hasBundledChannelPackageState({
    metadataKey: "persistedAuthState",
    channelId: params.channelId,
    cfg: params.cfg,
    env: params.env,
  });
}
