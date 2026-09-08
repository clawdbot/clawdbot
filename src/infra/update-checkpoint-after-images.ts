import { isDeepStrictEqual } from "node:util";
import {
  reopenUpdateCheckpoint,
  type UpdateCheckpointReadAccess,
  type UpdateCheckpointRef,
} from "./update-checkpoint.js";

/** Each phase owns only its committed row changes. Reopen every hash-bound image;
 * never manufacture a cumulative receipt by observing the current database. */
export async function reopenUpdateCheckpointAfterImages(
  params: {
    afterUpdateRef: UpdateCheckpointRef;
    afterUpdateRefs?: readonly UpdateCheckpointRef[];
  },
  access: UpdateCheckpointReadAccess,
) {
  const refs = params.afterUpdateRefs ?? [params.afterUpdateRef];
  if (
    !refs.length ||
    !isDeepStrictEqual(refs.at(-1), params.afterUpdateRef) ||
    new Set(refs.map((ref) => ref.checkpointId)).size !== refs.length
  ) {
    throw new Error("Restore after-image chain identity mismatch");
  }
  const images = [];
  for (const ref of refs) {
    images.push(await reopenUpdateCheckpoint(ref, access));
  }
  return {
    afterUpdate: images.at(-1)!,
    pluginIndexMutations: images.flatMap((image) => image.manifest.pluginIndexMutations ?? []),
  };
}
