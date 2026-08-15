// Keeps one provider failure from blocking the remaining media capabilities.
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { selectAttachments } from "./attachments.js";
import { runCapability } from "./runner.js";

export async function runMediaCapability(
  params: Parameters<typeof runCapability>[0],
): Promise<Awaited<ReturnType<typeof runCapability>>> {
  try {
    return await runCapability(params);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`Media understanding task failed: ${String(err)}`);
    }
    const selection = selectAttachments({
      capability: params.capability,
      attachments: params.media,
      policy: params.config?.attachments,
    });
    return {
      outputs: [],
      decision: {
        capability: params.capability,
        outcome: "failed",
        attachments: [],
        // Dropped attachments were never attempted; only selected ones failed.
        attachmentDispositions: Object.fromEntries([
          ...selection.selected.map(({ index }) => [index, { kind: "failed" as const }] as const),
          ...selection.droppedAttachmentIndexes.map(
            (index) => [index, { kind: "not-selected" as const }] as const,
          ),
        ]),
        ...(params.capability === "image" ? { nativeVisionActive: false } : {}),
      },
    };
  }
}
