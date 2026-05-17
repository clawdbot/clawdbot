import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  getMediaGenerationTaskProviderId,
  isActiveMediaGenerationTask,
} from "./media-generation-task-status-shared.js";

export const IMAGE_GENERATION_TASK_KIND = "image_generation";
const IMAGE_GENERATION_SOURCE_PREFIX = "image_generate";

export function isActiveImageGenerationTask(task: TaskRecord): boolean {
  return isActiveMediaGenerationTask({
    task,
    taskKind: IMAGE_GENERATION_TASK_KIND,
  });
}

export function getImageGenerationTaskProviderId(task: TaskRecord): string | undefined {
  return getMediaGenerationTaskProviderId(task, IMAGE_GENERATION_SOURCE_PREFIX);
}

export function findActiveImageGenerationTaskForSession(
  sessionKey?: string,
): TaskRecord | undefined {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
  });
}

export function buildImageGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    task,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
  });
}

export function buildImageGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    task,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    nounLabel: "Image generation",
    toolName: "image_generate",
    completionLabel: "image",
    duplicateGuard: params?.duplicateGuard,
  });
}

export function buildActiveImageGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    nounLabel: "Image generation",
    toolName: "image_generate",
    completionLabel: "images",
  });
}
