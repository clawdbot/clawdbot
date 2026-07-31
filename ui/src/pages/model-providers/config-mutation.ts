import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/index.ts";
import type { ModelProviderRowMessage } from "./view.ts";

export type ModelProviderConfigMutation = {
  key: string;
  raw: Record<string, unknown>;
  note: string;
  success: string;
  replacePaths?: string[];
};

export type ModelProviderConfigMutationResult =
  | { ok: false }
  | { ok: true; agentEpoch: number; warning: string | null };

type ModelProviderConfigMutationOwner = {
  runtimeConfig: RuntimeConfigCapability;
  agentEpoch: number;
  isCurrentClient: () => boolean;
  isCurrentAgent: () => boolean;
  refreshProviders: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setMessage: (message: ModelProviderRowMessage | null) => void;
};

export function modelProviderErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" && error.trim() ? error : t("modelProviders.requestFailed");
}

/**
 * Config patches are global; the initiating agent owns only busy/message UI.
 * Refresh warnings must preserve an already acknowledged mutation.
 */
export async function runModelProviderConfigMutation(
  owner: ModelProviderConfigMutationOwner,
  params: ModelProviderConfigMutation,
): Promise<ModelProviderConfigMutationResult> {
  const { agentEpoch, runtimeConfig } = owner;
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    await runtimeConfig.ensureLoaded();
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    const patched = await runtimeConfig.patch({
      raw: params.raw,
      note: params.note,
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    });
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (!patched) {
      if (owner.isCurrentAgent()) {
        owner.setMessage({
          kind: "error",
          text: runtimeConfig.state.lastError ?? t("modelProviders.configUnavailable"),
        });
      }
      return { ok: false };
    }

    let warning: string | null = null;
    try {
      await runtimeConfig.refresh();
      // The config owner records ordinary config.get failures in lastError
      // and resolves refresh(), so rejection alone cannot detect them.
      warning = runtimeConfig.state.lastError;
      if (!warning && owner.isCurrentClient()) {
        await owner.refreshProviders();
      }
    } catch (error) {
      // An acknowledged config patch is already committed; a later refresh
      // failure must not turn it into a failed credential edit.
      warning = modelProviderErrorMessage(error);
    }
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (owner.isCurrentAgent()) {
      owner.setMessage({
        kind: "success",
        text: params.success,
        ...(warning ? { warning } : {}),
      });
    }
    return { ok: true, agentEpoch, warning };
  } catch (error) {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setMessage({ kind: "error", text: modelProviderErrorMessage(error) });
    }
    return { ok: false };
  } finally {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setBusy(false);
    }
  }
}
