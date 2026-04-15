import { getMatrixRuntime } from "../../runtime.js";
import { syncMatrixOwnProfile, type MatrixProfileSyncResult } from "../profile.js";
import { withResolvedActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

export async function updateMatrixOwnProfile(
  opts: MatrixActionClientOpts & {
    displayName?: string;
    avatarUrl?: string;
    avatarPath?: string;
  } = {},
): Promise<MatrixProfileSyncResult> {
  const displayName = opts.displayName?.trim();
  const avatarUrl = opts.avatarUrl?.trim();
  const avatarPath = opts.avatarPath?.trim();
  const runtime = getMatrixRuntime();
  return await withResolvedActionClient(
    opts,
    async (client) => {
      const userId = await client.getUserId();
      return await syncMatrixOwnProfile({
        client,
        userId,
        displayName: displayName || undefined,
        avatarUrl: avatarUrl || undefined,
        avatarPath: avatarPath || undefined,
        loadAvatarFromUrl: async (url, maxBytes) => await runtime.media.loadWebMedia(url, maxBytes),
        loadAvatarFromPath: async (path, maxBytes) =>
          await runtime.media.loadWebMedia(path, {
            maxBytes,
            localRoots: opts.mediaLocalRoots,
          }),
      });
    },
    "persist",
  );
}
