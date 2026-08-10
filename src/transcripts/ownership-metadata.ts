// Marks sessions whose creator evaluated the current owner-binding contract.
// Absence identifies rows written before that fact was recorded.
export const TRANSCRIPT_OWNER_BINDING_VERSION = 1;

export function hasTranscriptOwnerBindingVersion(metadata: Record<string, unknown>): boolean {
  const version = metadata.ownerBindingVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 1;
}
