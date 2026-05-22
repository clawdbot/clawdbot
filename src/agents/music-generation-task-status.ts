import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  findDuplicateGuardMediaGenerationTaskForSession,
} from "./media-generation-task-status-shared.js";

export const MUSIC_GENERATION_TASK_KIND = "music_generation";
const MUSIC_GENERATION_SOURCE_PREFIX = "music_generate";
const RECENT_MUSIC_GENERATION_DUPLICATE_GUARD_MS = 2 * 60_000;

export function findActiveMusicGenerationTaskForSession(
  sessionKey?: string,
): TaskRecord | undefined {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    taskKind: MUSIC_GENERATION_TASK_KIND,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
  });
}

export function findDuplicateGuardMusicGenerationTaskForSession(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string },
): TaskRecord | undefined {
  return findDuplicateGuardMediaGenerationTaskForSession({
    sessionKey,
    taskKind: MUSIC_GENERATION_TASK_KIND,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    taskLabel: params?.prompt,
    requestKey: params?.requestKey,
    maxAgeMs: RECENT_MUSIC_GENERATION_DUPLICATE_GUARD_MS,
  });
}

export function buildMusicGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    task,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
  });
}

export function buildMusicGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    task,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    nounLabel: "Music generation",
    toolName: "music_generate",
    completionLabel: "music",
    duplicateGuard: params?.duplicateGuard,
  });
}

export function buildActiveMusicGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    sessionKey,
    taskKind: MUSIC_GENERATION_TASK_KIND,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    nounLabel: "Music generation",
    toolName: "music_generate",
    completionLabel: "music tracks",
  });
}
