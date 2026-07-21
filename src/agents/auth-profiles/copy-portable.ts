import fs from "node:fs/promises";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { buildPortableAuthProfileStoreForAgentCopy } from "./portability.js";
import { saveAuthProfileStore } from "./store.js";

/** Copies only credentials explicitly safe for a distinct agent directory. */
export async function copyPortableAuthProfiles(params: {
  destAgentDir: string;
  sourceAgentDir: string;
}): Promise<{ copied: number; skipped: number }> {
  const sourceStore = loadPersistedAuthProfileStore(params.sourceAgentDir);
  if (!sourceStore || Object.keys(sourceStore.profiles).length === 0) {
    return { copied: 0, skipped: 0 };
  }
  const portable = buildPortableAuthProfileStoreForAgentCopy(sourceStore);
  if (portable.copiedProfileIds.length === 0) {
    return { copied: 0, skipped: portable.skippedProfileIds.length };
  }
  await fs.mkdir(params.destAgentDir, { recursive: true });
  saveAuthProfileStore(portable.store, params.destAgentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
  return {
    copied: portable.copiedProfileIds.length,
    skipped: portable.skippedProfileIds.length,
  };
}
