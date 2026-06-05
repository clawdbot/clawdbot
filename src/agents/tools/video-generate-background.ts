/**
 * Video-generation background task lifecycle adapters.
 *
 * Specializes the shared media background runner with video status text and completion metadata.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

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
export const createVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.createTaskRun>
) => videoGenerationTaskLifecycle.createTaskRun(...params);

/** Records progress for an active video-generation task. */
export const recordVideoGenerationTaskProgress = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.recordTaskProgress>
) => videoGenerationTaskLifecycle.recordTaskProgress(...params);

/** Marks a video-generation task complete and stores generated attachment metadata. */
export const completeVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.completeTaskRun>
) => videoGenerationTaskLifecycle.completeTaskRun(...params);

/** Marks a video-generation task failed and emits task status updates. */
export const failVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.failTaskRun>
) => videoGenerationTaskLifecycle.failTaskRun(...params);

/** Wakes the waiting session turn with final video-generation output. */
export async function wakeVideoGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: VideoGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
}) {
  return await videoGenerationTaskLifecycle.wakeTaskCompletion(params);
}
