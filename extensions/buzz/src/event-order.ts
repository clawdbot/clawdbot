type BuzzEventRevision = {
  createdAt: number;
  eventId: string;
};

// NIP-01 retains the lowest event ID when replaceable events share a timestamp.
// Authorization-sensitive membership paths depend on this exact tie-break.
export function isNewerBuzzRevision(
  candidate: BuzzEventRevision,
  current: BuzzEventRevision | undefined,
): boolean {
  return (
    !current ||
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)
  );
}
