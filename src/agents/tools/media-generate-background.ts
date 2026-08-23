/**
 * Image generation background task facade.
 *
 * Binds shared detached media-task lifecycle behavior to image_generate labels and completion messages.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { recordRecentMediaGenerationTaskStartForSession } from "../media-generation-task-status-shared.js";
import {
  IMAGE_GENERATION_TASK_KIND,
  MUSIC_GENERATION_TASK_KIND,
  VIDEO_GENERATION_TASK_KIND,
} from "../media-generation-task-status.js";
import {
  buildMediaGenerationStartedToolResult,
  createMediaGenerationTaskLifecycle,
  notifyMediaGenerationAsyncTaskStarted,
  scheduleMediaGenerationTaskCompletion,
  shouldDetachMediaGenerationTask,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
  type MediaGenerationExecutionResult,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

/** Owns task admission and the shared foreground or detached generation lifecycle. */
export async function runMediaGenerationTask<T extends MediaGenerationExecutionResult>(params: {
  lifecycle: ReturnType<typeof createMediaGenerationTaskLifecycle>;
  generationLabel: "image" | "video" | "music";
  sessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  requestKey: string;
  providerId?: string;
  config?: OpenClawConfig;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
  run: (
    handle: MediaGenerationTaskHandle | null,
  ) => Promise<T & { contentText: string; details: Record<string, unknown> }>;
}) {
  const { generationLabel, lifecycle } = params;
  const toolName = `${generationLabel}_generate`;
  const progressSummary = `Generating ${generationLabel}`;
  const title = `${generationLabel.charAt(0).toUpperCase()}${generationLabel.slice(1)}`;
  const handle = lifecycle.createTaskRun({
    sessionKey: params.sessionKey,
    requesterAgentId: params.requesterAgentId,
    requesterOrigin: params.requesterOrigin,
    prompt: params.prompt,
    providerId: params.providerId,
  });

  if (handle && shouldDetachMediaGenerationTask(params.sessionKey, params.requesterAgentId)) {
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: params.sessionKey,
      agentId: params.requesterAgentId,
      taskKind: `${generationLabel}_generation`,
      sourcePrefix: toolName,
      taskId: handle.taskId,
      runId: handle.runId,
      taskLabel: params.prompt,
      requestKey: params.requestKey,
      providerId: params.providerId,
      progressSummary,
    });
    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle,
      scheduleBackgroundWork: params.scheduleBackgroundWork,
      progressSummary,
      config: params.config,
      toolName: `${title} generation`,
      onWakeFailure: params.onFailure,
      run: () => params.run(handle),
    });
    await notifyMediaGenerationAsyncTaskStarted({
      callback: params.onAsyncTaskStarted,
      message: `${title} generation started; wait for the generated ${generationLabel} completion event.`,
      toolName,
      handle,
      onFailure: params.onFailure,
    });
    return buildMediaGenerationStartedToolResult({
      toolName,
      generationLabel,
      completionLabel: generationLabel,
      taskHandle: handle,
      detailExtras: params.detailExtras,
      messages: params.messages,
    });
  }

  try {
    const executed = await params.run(handle);
    lifecycle.completeTaskRun({
      handle,
      provider: executed.provider,
      model: executed.model,
      count: executed.count,
    });
    return {
      content: [{ type: "text" as const, text: executed.contentText }],
      details: executed.details,
    };
  } catch (error) {
    lifecycle.failTaskRun({ handle, error });
    throw error;
  }
}

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
