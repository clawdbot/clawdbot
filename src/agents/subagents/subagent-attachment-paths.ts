import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT = "/openclaw/attachments";

export function resolveSubagentAttachmentRootDir(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "attachments", "subagents", normalizeAgentId(agentId));
}

export function resolveSubagentAttachmentDir(params: {
  agentId: string;
  attachmentId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(
    resolveSubagentAttachmentRootDir(params.agentId, params.env),
    params.attachmentId,
  );
}
