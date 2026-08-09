/**
 * Music-generation task status adapters. The module specializes the shared
 * media-generation task helpers with music task ids, duplicate guards, and
 * user-facing status text.
 */
import { createMediaGenerationTaskStatusOwner } from "./media-generation-task-status-shared.js";

/** Task kind used for music generation task registry records. */
export const MUSIC_GENERATION_TASK_KIND = "music_generation";

/** Binds music-specific task identity, duplicate guards, and visible status text. */
export const {
  findActiveTaskForSession: findActiveMusicGenerationTaskForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardMusicGenerationTaskForSession,
  buildTaskStatusDetails: buildMusicGenerationTaskStatusDetails,
  buildTaskStatusText: buildMusicGenerationTaskStatusText,
  buildActiveTaskPromptContextForSession: buildActiveMusicGenerationTaskPromptContextForSession,
} = createMediaGenerationTaskStatusOwner({
  taskKind: MUSIC_GENERATION_TASK_KIND,
  toolName: "music_generate",
  nounLabel: "Music generation",
  completionLabel: "music",
  promptCompletionLabel: "music tracks",
});
