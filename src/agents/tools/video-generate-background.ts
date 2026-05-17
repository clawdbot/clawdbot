import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

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

export const createVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.createTaskRun>
) => videoGenerationTaskLifecycle.createTaskRun(...params);

export const recordVideoGenerationTaskProgress = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.recordTaskProgress>
) => videoGenerationTaskLifecycle.recordTaskProgress(...params);

export const completeVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.completeTaskRun>
) => videoGenerationTaskLifecycle.completeTaskRun(...params);

export const failVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.failTaskRun>
) => videoGenerationTaskLifecycle.failTaskRun(...params);

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
  await videoGenerationTaskLifecycle.wakeTaskCompletion(params);
}
