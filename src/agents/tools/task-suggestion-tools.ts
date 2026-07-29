/** Model tools for proposing and withdrawing operator-approved follow-up work. */
import path from "node:path";
import { Type } from "typebox";
import type {
  TaskSuggestionsCreateResult,
  TaskSuggestionsDismissResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
  SPAWN_TASK_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const SpawnTaskToolSchema = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: 60,
      description: "Imperative task title under 60 characters.",
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 32_768,
      description: "Self-contained task prompt with relevant file paths and context.",
    }),
    tldr: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description: "One or two plain-language sentences explaining the value; no code or paths.",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description: "Absolute project directory; defaults to the current project.",
      }),
    ),
  },
  { additionalProperties: false },
);

const SpawnTaskOutputSchema = Type.Object(
  { task_id: Type.String() },
  { additionalProperties: false },
);

const DismissTaskToolSchema = Type.Object(
  {
    task_id: Type.String({
      minLength: 1,
      maxLength: 128,
      description: "ID returned by spawn_task.",
    }),
    reason: Type.Optional(
      Type.String({ maxLength: 1_024, description: "Short reason the suggestion is stale." }),
    ),
  },
  { additionalProperties: false },
);

type GatewayCaller = typeof callGatewayTool;

export function createTaskSuggestionTools(params: {
  sessionKey: string;
  agentId?: string;
  cwd: string;
  callGateway?: GatewayCaller;
}): AnyAgentTool[] {
  const gatewayCall = params.callGateway ?? callGatewayTool;
  return [
    {
      label: "Suggest Task",
      name: "spawn_task",
      displaySummary: SPAWN_TASK_TOOL_DISPLAY_SUMMARY,
      description: [
        "Suggest confirmed valuable out-of-scope follow-up: dead code, stale docs, missing coverage, verified TODO, security issue.",
        "Operator suggestion only; does not start work.",
      ].join(" "),
      parameters: SpawnTaskToolSchema,
      outputSchema: SpawnTaskOutputSchema,
      execute: async (_toolCallId, args) => {
        const input = args as Record<string, unknown>;
        const title = readStringParam(input, "title", { required: true });
        const prompt = readStringParam(input, "prompt", { required: true });
        const tldr = readStringParam(input, "tldr", { required: true });
        const cwd = readStringParam(input, "cwd") ?? params.cwd;
        if (title.length > 60) {
          throw new ToolInputError("title must be at most 60 characters");
        }
        if (!path.isAbsolute(cwd)) {
          throw new ToolInputError("cwd must be an absolute path");
        }
        const result = await gatewayCall<TaskSuggestionsCreateResult>(
          "taskSuggestions.create",
          {},
          {
            title,
            prompt,
            tldr,
            cwd,
            sessionKey: params.sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          },
        );
        return jsonResult({ task_id: result.taskId });
      },
    },
    {
      label: "Dismiss Task",
      name: "dismiss_task",
      displaySummary: DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
      description:
        "Withdraw stale/irrelevant pending spawn_task. Accepted suggestion cannot withdraw.",
      parameters: DismissTaskToolSchema,
      execute: async (_toolCallId, args) => {
        const input = args as Record<string, unknown>;
        const taskId = readStringParam(input, "task_id", { required: true });
        const reason = readStringParam(input, "reason");
        const result = await gatewayCall<TaskSuggestionsDismissResult>(
          "taskSuggestions.dismiss",
          {},
          {
            taskId,
            ...(reason ? { reason } : {}),
          },
        );
        return jsonResult({ task_id: taskId, dismissed: result.dismissed });
      },
    },
  ];
}
