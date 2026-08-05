import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../config/index.ts";

export type SkillConfigMutationOwner = Pick<RuntimeConfigCapability, "runExternalMutation">;

type SkillConfigPatch = { skillKey: string; enabled?: boolean; apiKey?: string };

export function normalizeSkillApiKeyReplacement(value: string | undefined): string | undefined {
  const apiKey = value?.trim();
  // Blank skills.update API keys explicitly clear stored credentials; this UI only replaces them.
  return apiKey || undefined;
}

export async function runSkillConfigMutation(
  owner: SkillConfigMutationOwner,
  expectedClient: GatewayBrowserClient,
  patch: SkillConfigPatch,
  canDispatch: () => boolean,
): Promise<string | null> {
  let requestError: Error | undefined;
  // Settings autosave and skills.update persist the same config; one owner
  // prevents a pending draft from restoring an older skill credential/toggle.
  const mutation = await owner.runExternalMutation(
    async (client) => {
      if (client !== expectedClient) {
        throw new Error("Connection changed before the skill update started.");
      }
      try {
        return await client.request("skills.update", patch);
      } catch (error) {
        requestError = error instanceof Error ? error : new Error(String(error));
        throw requestError;
      }
    },
    {
      canDispatch,
      dispatchError: "Access changed before the skill update started.",
    },
  );
  if (!mutation.ok) {
    throw requestError ?? new Error(mutation.error);
  }
  return mutation.refresh.ok ? null : mutation.refresh.error;
}

export function skillConfigMutationSuccess(
  message: string,
  refreshError: string | null,
): { kind: "success"; message: string } {
  return {
    kind: "success",
    message: refreshError ? `${message}\n${refreshError}` : message,
  };
}
