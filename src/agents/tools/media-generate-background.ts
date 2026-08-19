/**
 * Image generation background task facade.
 *
 * Binds shared detached media-task lifecycle behavior to image_generate labels and completion messages.
 */
import {
  IMAGE_GENERATION_TASK_KIND,
  MUSIC_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "../media-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

/** Detached image generation task handle. */
export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;

/** Shared lifecycle instance configured for image generation. */
export const imageGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "image_generate",
  taskKind: IMAGE_GENERATION_TASK_KIND,
  label: "Image generation",
  queuedProgressSummary: "Queued image generation",
  generatedLabel: "image",
  failureProgressSummary: "Image generation failed",
  eventSource: "image_generation",
  announceType: "image generation task",
  completionLabel: "image",
});

/** Creates an image generation task ledger run. */
export const createImageGenerationTaskRun = imageGenerationTaskLifecycle.createTaskRun;

/** Records progress for an image generation task. */
export const recordImageGenerationTaskProgress = imageGenerationTaskLifecycle.recordTaskProgress;

/** Completes an image generation task ledger run. */
export const completeImageGenerationTaskRun = imageGenerationTaskLifecycle.completeTaskRun;

/** Marks an image generation task ledger run as failed. */
export const failImageGenerationTaskRun = imageGenerationTaskLifecycle.failTaskRun;

/**
 * Music generation background task facade.
 *
 * Binds shared detached media-task lifecycle behavior to music_generate labels and completion messages.
 */

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

/**
 * Video-generation background task lifecycle adapters.
 *
 * Specializes the shared media background runner with video status text and completion metadata.
 */

export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

/** Shared lifecycle configured with video-specific status text and event metadata. */
export const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "video_generate",
  taskKind: VIDEO_GENERATION_TASK_KIND,
  label: "Video generation",
  queuedProgressSummary: "Queued video generation",
  generatedLabel: "video",
  failureProgressSummary: "Video generation failed",
  eventSource: "video_generation",
  announceType: "video generation task",
  completionLabel: "video",
});

/** Creates a queued video-generation background task run. */
export const createVideoGenerationTaskRun = videoGenerationTaskLifecycle.createTaskRun;

/** Records progress for an active video-generation task. */
export const recordVideoGenerationTaskProgress = videoGenerationTaskLifecycle.recordTaskProgress;

/** Marks a video-generation task complete and stores generated attachment metadata. */
export const completeVideoGenerationTaskRun = videoGenerationTaskLifecycle.completeTaskRun;

/** Marks a video-generation task failed and emits task status updates. */
export const failVideoGenerationTaskRun = videoGenerationTaskLifecycle.failTaskRun;
