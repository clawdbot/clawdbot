import { systemOwnedDeclarationKeyNamespace } from "./system-owned-declaration.js";
import { isSystemOwnedCronPayloadKind, type CronJob } from "./types.js";

export const CRON_GROUP_MAX_LENGTH = 64;
export const CRON_TAG_MAX_LENGTH = 64;
export const CRON_TAGS_MAX_COUNT = 20;

export type CronAutomationType =
  | "agentTurn"
  | "command"
  | "script"
  | "systemEvent"
  | "heartbeat"
  | "skillCollectionReview"
  | "unknown";

export function normalizeCronGroup(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeCronTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const tag = item.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags.length > 0 ? tags : undefined;
}

export function assertValidCronMetadata(input: { group?: unknown; tags?: unknown }): void {
  if (input.group !== undefined && input.group !== null) {
    const group = normalizeCronGroup(input.group);
    if (!group) {
      throw new Error("cron group must not be blank");
    }
    if (group.length > CRON_GROUP_MAX_LENGTH) {
      throw new Error(`cron group must be at most ${CRON_GROUP_MAX_LENGTH} characters`);
    }
    if (group.toLowerCase() === "system") {
      throw new Error('cron group "System" is reserved for Gateway-owned automations');
    }
  }
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags)) {
      throw new Error("cron tags must be an array of strings");
    }
    if (input.tags.length > CRON_TAGS_MAX_COUNT) {
      throw new Error(`cron tags must contain at most ${CRON_TAGS_MAX_COUNT} items`);
    }
    const seen = new Set<string>();
    for (const item of input.tags) {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error("cron tags must not contain blank values");
      }
      const tag = item.trim();
      if (tag.length > CRON_TAG_MAX_LENGTH) {
        throw new Error(`cron tags must be at most ${CRON_TAG_MAX_LENGTH} characters each`);
      }
      const key = tag.toLowerCase();
      if (seen.has(key)) {
        throw new Error("cron tags must not contain duplicates");
      }
      seen.add(key);
    }
  }
}

export function isSystemOwnedCronJob(job: Pick<CronJob, "declarationKey" | "payload">): boolean {
  return (
    isSystemOwnedCronPayloadKind(job.payload.kind) ||
    systemOwnedDeclarationKeyNamespace(job.declarationKey) !== undefined
  );
}

export function resolveCronJobGroup(
  job: Pick<CronJob, "declarationKey" | "payload" | "group">,
): string {
  if (isSystemOwnedCronJob(job)) {
    return "System";
  }
  return normalizeCronGroup(job.group) ?? "Ungrouped";
}

export function resolveCronAutomationType(job: Pick<CronJob, "payload">): CronAutomationType {
  const kind = job.payload?.kind;
  return kind === "agentTurn" ||
    kind === "command" ||
    kind === "script" ||
    kind === "systemEvent" ||
    kind === "heartbeat" ||
    kind === "skillCollectionReview"
    ? kind
    : "unknown";
}
