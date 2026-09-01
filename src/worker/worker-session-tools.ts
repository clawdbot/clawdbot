import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  GitHubPublicationBodySchema,
  GitHubPublicationTitleSchema,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  WORKER_SESSION_TOOL_MAX_TEXT_LENGTH,
  type WorkerGitHubPublishParams,
  type WorkerGitHubPublishResponseFrame,
  type WorkerPortalParams,
  type WorkerPortalResponseFrame,
  WorkerPortalParamsSchema,
  type WorkerSessionsSendParams,
  type WorkerSessionsSendResponseFrame,
  type WorkerSessionsSpawnParams,
  type WorkerSessionsSpawnResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  SkillLibraryWorkshopSchema,
  type WorkerSkillWorkshopBinding,
  type WorkerSkillWorkshopParams,
  type WorkerSkillWorkshopResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import type { AgentToolResult } from "../agents/runtime/index.js";
import { SESSIONS_SEND_RESULT_GUIDANCE } from "../agents/tool-description-presets.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  PORTAL_TOOL_DESCRIPTION,
  PortalOutputSchema,
  PortalToolSchema,
} from "../agents/tools/portal-tool-contract.js";
import { createLibrarySkillWorkshopDescriptor } from "../agents/tools/skill-workshop-tool-library.js";

type WorkerSessionRpcClient = {
  requestSkillWorkshop?(
    params: WorkerSkillWorkshopParams,
  ): Promise<WorkerSkillWorkshopResponseFrame>;
  requestSessionsSpawn(
    params: WorkerSessionsSpawnParams,
  ): Promise<WorkerSessionsSpawnResponseFrame>;
  requestSessionsSend(params: WorkerSessionsSendParams): Promise<WorkerSessionsSendResponseFrame>;
  requestGitHubPublish(
    params: WorkerGitHubPublishParams,
  ): Promise<WorkerGitHubPublishResponseFrame>;
  requestPortal(params: WorkerPortalParams): Promise<WorkerPortalResponseFrame>;
};

function parseToolResult(frame: WorkerSessionsSpawnResponseFrame) {
  if (!frame.ok) {
    throw new Error(frame.error.message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.payload.resultJson);
  } catch (error) {
    throw new Error("Gateway returned an invalid worker session tool result", { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { content?: unknown }).content)
  ) {
    throw new Error("Gateway returned an invalid worker session tool result");
  }
  return parsed as AgentToolResult<unknown>;
}

export function createWorkerSessionTools(
  client: WorkerSessionRpcClient,
  skillAuthoring?: WorkerSkillWorkshopBinding,
): AnyAgentTool[] {
  const workshop: AnyAgentTool | undefined = skillAuthoring
    ? {
        ...createLibrarySkillWorkshopDescriptor(skillAuthoring.multipleProfiles),
        parameters: SkillLibraryWorkshopSchema,
        execute: async (toolCallId, raw) => {
          if (!Value.Check(SkillLibraryWorkshopSchema, raw) || !client.requestSkillWorkshop) {
            throw new Error("Worker Workshop transport is unavailable or arguments are invalid.");
          }
          return parseToolResult(await client.requestSkillWorkshop({ toolCallId, arguments: raw }));
        },
      }
    : undefined;
  return [
    ...(workshop ? [workshop] : []),
    {
      label: "GitHub Publish",
      name: "github_publish",
      description:
        "Request Gateway-owned publication of this cloud session. Call only after the work is complete, then finish the turn. The Gateway reconciles the workspace, commits remaining changes as the effective GitHub user, pushes an exact HTTPS branch, and creates or reuses a draft pull request without sending credentials to this worker.",
      parameters: Type.Object(
        {
          title: Type.Optional(GitHubPublicationTitleSchema),
          body: Type.Optional(GitHubPublicationBodySchema),
        },
        { additionalProperties: false },
      ),
      execute: async (toolCallId, raw) => {
        // SAFETY: the embedded agent runtime validates raw against this tool's schema.
        const params = raw as Omit<WorkerGitHubPublishParams, "toolCallId">;
        return parseToolResult(await client.requestGitHubPublish({ toolCallId, ...params }));
      },
    },
    {
      label: "Sessions",
      name: "sessions_spawn",
      description:
        "Spawn a visible cloud child session in a fresh managed worktree. The child inherits the current cloud placement profile and attenuated tool policy.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: WORKER_SESSION_TOOL_MAX_TEXT_LENGTH }),
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        runTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 })),
      }),
      execute: async (toolCallId, raw) => {
        const params = raw as Omit<WorkerSessionsSpawnParams, "toolCallId">;
        return parseToolResult(await client.requestSessionsSpawn({ toolCallId, ...params }));
      },
    },
    {
      label: "Session Send",
      name: "sessions_send",
      description: `Send a message to an authorized parent, child, or sibling session on this Gateway, whether it runs on the Gateway, a paired device, or a cloud worker. Cross-tree and stale-incarnation targets are denied by the Gateway. ${SESSIONS_SEND_RESULT_GUIDANCE} Status "no_reply" is terminal; do not wait for another result.`,
      parameters: Type.Object({
        sessionKey: Type.String({ minLength: 1, maxLength: 1_024 }),
        message: Type.String({ minLength: 1, maxLength: WORKER_SESSION_TOOL_MAX_TEXT_LENGTH }),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 })),
      }),
      execute: async (toolCallId, raw) => {
        const params = raw as Omit<WorkerSessionsSendParams, "toolCallId">;
        return parseToolResult(await client.requestSessionsSend({ toolCallId, ...params }));
      },
    },
    {
      label: "Portal",
      name: "portal",
      description: PORTAL_TOOL_DESCRIPTION,
      parameters: PortalToolSchema,
      outputSchema: PortalOutputSchema,
      execute: async (toolCallId, raw) => {
        if (!Value.Check(PortalToolSchema, raw)) {
          throw new Error("Invalid portal tool arguments");
        }
        const params = { toolCallId, ...raw };
        if (!Value.Check(WorkerPortalParamsSchema, params)) {
          throw new Error("Portal tool arguments exceed the worker protocol limits");
        }
        return parseToolResult(await client.requestPortal(params));
      },
    },
  ];
}
