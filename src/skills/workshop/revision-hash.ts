import { sha256Hex } from "../../infra/crypto-digest.js";
import type { SkillProposalRecord } from "./types.js";

export function hashSkillProposalRevision(
  record: Pick<SkillProposalRecord, "draftHash" | "proposedVersion" | "supportFiles">,
): string {
  return sha256Hex(
    JSON.stringify({
      proposedVersion: record.proposedVersion,
      contentSha256: record.draftHash,
      supportFiles: (record.supportFiles ?? [])
        .map((file) => ({
          path: file.path,
          sha256: file.hash,
          sizeBytes: file.sizeBytes,
        }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    }),
  );
}
