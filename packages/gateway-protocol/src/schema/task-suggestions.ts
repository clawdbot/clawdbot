// Gateway Protocol schema module defines ephemeral follow-up task suggestions.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const TaskIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const TaskTitleSchema = Type.String({ minLength: 1, maxLength: 60 });
const TaskPromptSchema = Type.String({ minLength: 1, maxLength: 32_768 });
const TaskTldrSchema = Type.String({ minLength: 1, maxLength: 1_024 });
const TaskCwdSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const TaskSessionKeySchema = Type.String({ minLength: 1, maxLength: 512 });
const TaskAgentIdSchema = Type.String({ minLength: 1, maxLength: 128 });

/** One model-proposed follow-up task waiting for operator action. */
export const TaskSuggestionSchema = closedObject({
  id: TaskIdSchema,
  title: TaskTitleSchema,
  prompt: TaskPromptSchema,
  tldr: TaskTldrSchema,
  cwd: TaskCwdSchema,
  sessionKey: TaskSessionKeySchema,
  agentId: Type.Optional(TaskAgentIdSchema),
  createdAt: Type.Integer({ minimum: 0 }),
});

/** Lists pending suggestions, optionally narrowed to one source session. */
export const TaskSuggestionsListParamsSchema = closedObject({
  sessionKey: Type.Optional(TaskSessionKeySchema),
  agentId: Type.Optional(TaskAgentIdSchema),
});

export const TaskSuggestionsListResultSchema = closedObject({
  suggestions: Type.Array(TaskSuggestionSchema),
});

/** Creates a pending suggestion without starting any work. */
export const TaskSuggestionsCreateParamsSchema = closedObject({
  title: TaskTitleSchema,
  prompt: TaskPromptSchema,
  tldr: TaskTldrSchema,
  cwd: TaskCwdSchema,
  sessionKey: TaskSessionKeySchema,
  agentId: Type.Optional(TaskAgentIdSchema),
});

export const TaskSuggestionsCreateResultSchema = closedObject({
  taskId: TaskIdSchema,
  suggestion: TaskSuggestionSchema,
});

export const TaskSuggestionResolutionSchema = Type.Union([
  Type.Literal("dismissed"),
  Type.Literal("accepted"),
  Type.Literal("expired"),
]);

/** Atomically claims a pending suggestion and starts its server-owned worktree session. */
export const TaskSuggestionsAcceptParamsSchema = closedObject({ taskId: TaskIdSchema });

export const TaskSuggestionsAcceptResultSchema = closedObject({
  taskId: TaskIdSchema,
  key: TaskSessionKeySchema,
});

/** Removes a pending suggestion without starting work. */
export const TaskSuggestionsDismissParamsSchema = closedObject({
  taskId: TaskIdSchema,
  reason: Type.Optional(Type.String({ maxLength: 1_024 })),
});

export const TaskSuggestionsDismissResultSchema = closedObject({
  taskId: TaskIdSchema,
  dismissed: Type.Boolean(),
});

/** Live update emitted when a pending suggestion is created or resolved. */
export const TaskSuggestionEventSchema = Type.Union([
  closedObject({ action: Type.Literal("created"), suggestion: TaskSuggestionSchema }),
  closedObject({
    action: Type.Literal("resolved"),
    taskId: TaskIdSchema,
    resolution: TaskSuggestionResolutionSchema,
  }),
]);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type TaskSuggestion = Static<typeof TaskSuggestionSchema>;
export type TaskSuggestionEvent = Static<typeof TaskSuggestionEventSchema>;
export type TaskSuggestionResolution = Static<typeof TaskSuggestionResolutionSchema>;
export type TaskSuggestionsAcceptParams = Static<typeof TaskSuggestionsAcceptParamsSchema>;
export type TaskSuggestionsAcceptResult = Static<typeof TaskSuggestionsAcceptResultSchema>;
export type TaskSuggestionsCreateParams = Static<typeof TaskSuggestionsCreateParamsSchema>;
export type TaskSuggestionsCreateResult = Static<typeof TaskSuggestionsCreateResultSchema>;
export type TaskSuggestionsDismissParams = Static<typeof TaskSuggestionsDismissParamsSchema>;
export type TaskSuggestionsDismissResult = Static<typeof TaskSuggestionsDismissResultSchema>;
export type TaskSuggestionsListParams = Static<typeof TaskSuggestionsListParamsSchema>;
export type TaskSuggestionsListResult = Static<typeof TaskSuggestionsListResultSchema>;
