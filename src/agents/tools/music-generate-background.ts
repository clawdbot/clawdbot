/**
 * Music generation background task facade.
 *
 * Binds shared detached media-task lifecycle behavior to music_generate labels and completion messages.
 */
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;

/** Shared lifecycle configured with music-specific status text and event metadata. */
export const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "music_generate",
  taskKind: MUSIC_GENERATION_TASK_KIND,
  label: "Music generation",
  queuedProgressSummary: "Queued music generation",
  generatedLabel: "track",
  failureProgressSummary: "Music generation failed",
  eventSource: "music_generation",
  announceType: "music generation task",
  completionLabel: "music",
});

/** Creates a queued music-generation background task run. */
export const createMusicGenerationTaskRun = musicGenerationTaskLifecycle.createTaskRun;

/** Records progress for an active music-generation task. */
export const recordMusicGenerationTaskProgress = musicGenerationTaskLifecycle.recordTaskProgress;

/** Marks a music-generation task complete and stores generated attachment metadata. */
export const completeMusicGenerationTaskRun = musicGenerationTaskLifecycle.completeTaskRun;

/** Marks a music-generation task failed and emits task status updates. */
export const failMusicGenerationTaskRun = musicGenerationTaskLifecycle.failTaskRun;
