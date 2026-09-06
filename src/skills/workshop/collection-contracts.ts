export const AUTONOMOUS_SKILL_MAX_CHARS = 10_000;

export function autonomousSkillSizeError(
  name: string,
  currentChars: number,
  resultChars: number,
): string | undefined {
  if (
    resultChars <= AUTONOMOUS_SKILL_MAX_CHARS ||
    (currentChars > AUTONOMOUS_SKILL_MAX_CHARS && resultChars < currentChars)
  ) {
    return undefined;
  }
  return `skill "${name}" would be ${resultChars} characters; autonomous limit is 10,000. Prune stale steps; move reference and examples into a bundled file.`;
}

export type SkillCollectionRestoreResult = {
  backupId: string;
  restored: string[];
  removed: string[];
};
