// Memory Core plugin module formats deterministic recall metadata for promoted entries.
import { extractProjectKeysFromCuratedEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PromotionCandidate } from "./short-term-promotion-types.js";

const MAX_PROMOTION_TRIGGER_PHRASE_CHARS = 64;

export type PromotionProjectGroup<
  Candidate extends Pick<PromotionCandidate, "projectKey"> = PromotionCandidate,
> = {
  projectKey?: string;
  candidates: Candidate[];
};

function normalizePromotionTriggerPhrase(value: string): string {
  const singleLine = value
    .replace(/<!--|-->/gu, " ")
    .replace(/[\r\n,;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(singleLine).slice(0, MAX_PROMOTION_TRIGGER_PHRASE_CHARS).join("").trimEnd();
}

function resolvePromotionProjectKey(
  candidate: Pick<PromotionCandidate, "projectKey">,
): string | undefined {
  return candidate.projectKey && !/[\r\n<>]/u.test(candidate.projectKey)
    ? candidate.projectKey
    : undefined;
}

export function groupPromotionCandidatesByProjectKey<
  Candidate extends Pick<PromotionCandidate, "projectKey">,
>(candidates: readonly Candidate[]): PromotionProjectGroup<Candidate>[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const projectKey = resolvePromotionProjectKey(candidate) ?? "";
    groups.set(projectKey, [...(groups.get(projectKey) ?? []), candidate]);
  }
  // Stable group order keeps both prompts and append fallback bytes cache-friendly.
  return [...groups.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([projectKey, groupedCandidates]) =>
      projectKey
        ? { projectKey, candidates: groupedCandidates }
        : { candidates: groupedCandidates },
    );
}

export function memoryEntryMatchesPromotionProjectGroup(
  entry: string,
  projectKey: string | undefined,
): boolean {
  const annotations = extractProjectKeysFromCuratedEntry(entry);
  return annotations.valid && annotations.keys.join("; ") === (projectKey ?? "");
}

export function buildPromotionRecallAnnotations(
  candidate: Pick<PromotionCandidate, "conceptTags" | "score" | "projectKey">,
): string {
  const triggers = candidate.conceptTags
    .slice(0, 3)
    .map(normalizePromotionTriggerPhrase)
    .filter(Boolean)
    .join(", ");
  const importance = Math.min(10, Math.max(3, Math.round(candidate.score * 10)));
  const projectKey = resolvePromotionProjectKey(candidate);
  const project = projectKey ? ` <!-- project: ${projectKey} -->` : "";
  return `<!-- trigger: ${triggers} --> <!-- importance: ${importance} -->${project}`;
}
