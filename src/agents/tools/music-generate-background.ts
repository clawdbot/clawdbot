import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;

const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "music_generate",
  taskKind: MUSIC_GENERATION_TASK_KIND,
  label: "Music generation",
  queuedProgressSummary: "Queued music generation",
  generatedLabel: "track",
  failureProgressSummary: "Music generation failed",
  eventSource: "music_generation",
  announceType: "music generation task",
  completionLabel: "music",
  directCompletionDelivery: "disabled",
});

export const createMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.createTaskRun>
) => musicGenerationTaskLifecycle.createTaskRun(...params);

export const recordMusicGenerationTaskProgress = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.recordTaskProgress>
) => musicGenerationTaskLifecycle.recordTaskProgress(...params);

export const completeMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.completeTaskRun>
) => musicGenerationTaskLifecycle.completeTaskRun(...params);

export const failMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.failTaskRun>
) => musicGenerationTaskLifecycle.failTaskRun(...params);

export async function wakeMusicGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MusicGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await musicGenerationTaskLifecycle.wakeTaskCompletion(params);
}
