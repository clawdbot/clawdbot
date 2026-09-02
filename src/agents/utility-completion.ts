import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";

/** Capture model identity only; the isolated execution owner resolves its own auth. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveSimpleCompletionSelectionForAgent>[0] & {
    preferredProfile?: string;
  },
) {
  const selection = resolveSimpleCompletionSelectionForAgent(params);
  if (!selection) {
    throw new Error(`No utility model configured for agent ${params.agentId}.`);
  }
  return {
    config: params.cfg,
    provider: selection.provider,
    model: selection.modelId,
    authProfileId: selection.profileId ?? params.preferredProfile,
    agentId: params.agentId,
    agentDir: selection.agentDir,
  };
}
