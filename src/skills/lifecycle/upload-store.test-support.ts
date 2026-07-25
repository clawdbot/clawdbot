import type { SkillUploadStore } from "./upload-store.js";
import "./upload-store.js";

type SkillUploadStoreTestApi = {
  createSkillUploadStore(options?: {
    env?: NodeJS.ProcessEnv;
    installLeaseHeartbeatMs?: number;
    installLeaseMs?: number;
    now?: () => number;
    path?: string;
    tempRootDir?: string;
    ttlMs?: number;
  }): SkillUploadStore;
};

function getTestApi(): SkillUploadStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.skillUploadStoreTestApi")
  ] as SkillUploadStoreTestApi;
}

export function createSkillUploadStore(
  options?: Parameters<SkillUploadStoreTestApi["createSkillUploadStore"]>[0],
): SkillUploadStore {
  return getTestApi().createSkillUploadStore(options);
}
