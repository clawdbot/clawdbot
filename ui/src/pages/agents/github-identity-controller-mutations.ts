import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type {
  GitHubConfigureMutationResult,
  GitHubIdentityDraft,
  GitHubIdentityScope,
  RequestOwner,
} from "./github-identity-controller-shared.ts";

type MutationOwner = {
  owner: RequestOwner;
  scope: GitHubIdentityScope;
  isCurrent: () => boolean;
  isConfigurable: () => boolean;
  begin: () => void;
  runExternalMutation: RuntimeConfigCapability["runExternalMutation"];
  applyStatus: (
    status: ToolsGitHubStatusResult,
    nextDraft: GitHubIdentityDraft,
    refreshError: string | null,
  ) => void;
  finish: (succeeded: boolean) => void;
  setError: (error: string) => void;
};

async function deleteSetupHandoff(client: GatewayBrowserClient, secretName: string) {
  await client.request("secrets.store.delete", { name: secretName }).catch(() => undefined);
}

async function runConfigureMutation(
  mutation: MutationOwner,
  params: Record<string, unknown>,
): Promise<GitHubConfigureMutationResult> {
  return await mutation.runExternalMutation(
    (client) => {
      if (client !== mutation.owner.client) {
        throw new Error("Connection changed before the GitHub identity update started.");
      }
      return client.request<ToolsGitHubStatusResult>("tools.github.configure", params);
    },
    {
      canDispatch: () => mutation.isCurrent() && mutation.isConfigurable(),
      dispatchError: "Access changed before the GitHub identity update started.",
    },
  );
}

export async function runGitHubIdentityConfigure(
  mutation: MutationOwner & {
    draft: GitHubIdentityDraft;
  },
): Promise<void> {
  const name = mutation.draft.name.trim();
  const email = mutation.draft.email.trim();
  mutation.begin();
  let stored = false;
  let secretName = "";
  let succeeded = false;
  try {
    secretName = `github-setup-${generateUUID().replaceAll("-", "").toLowerCase()}`;
    await mutation.owner.client.request("secrets.store.set", {
      name: secretName,
      value: mutation.draft.token,
      kind: "secret",
      allowedHosts: [],
    });
    stored = true;
    if (!mutation.isCurrent()) {
      await deleteSetupHandoff(mutation.owner.client, secretName);
      return;
    }
    const result = await runConfigureMutation(mutation, {
      scope: mutation.scope,
      agentId: mutation.owner.agentId,
      mode: "managed",
      secretName,
      ...(name || email
        ? {
            gitAuthor: {
              ...(name ? { name } : {}),
              ...(email ? { email } : {}),
            },
          }
        : {}),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    stored = false;
    mutation.applyStatus(
      result.value,
      { ...mutation.draft, token: "" },
      result.refresh.ok ? null : result.refresh.error,
    );
    succeeded = true;
  } catch (error) {
    if (stored) {
      await deleteSetupHandoff(mutation.owner.client, secretName);
    }
    if (mutation.isCurrent()) {
      mutation.setError(formatUiError(error));
    }
  } finally {
    mutation.finish(succeeded);
  }
}

export async function runGitHubIdentityInherit(
  mutation: MutationOwner & {
    canContinue: () => boolean;
    setConfirmationPending: (pending: boolean) => void;
  },
): Promise<void> {
  mutation.setConfirmationPending(true);
  let confirmed = false;
  try {
    confirmed = await showConfirmDialog({
      title:
        mutation.scope === "agent"
          ? t("agentTools.githubUseSystemConfirmTitle")
          : t("agentTools.githubUseNativeConfirmTitle"),
      message:
        mutation.scope === "agent"
          ? t("agentTools.githubUseSystemConfirmMessage")
          : t("agentTools.githubUseNativeConfirmMessage"),
      confirmLabel:
        mutation.scope === "agent"
          ? t("agentTools.githubUseSystemNewRuns")
          : t("agentTools.githubUseNativeNewRuns"),
    });
  } finally {
    mutation.setConfirmationPending(false);
  }
  if (!confirmed || !mutation.isCurrent() || !mutation.canContinue()) {
    return;
  }
  mutation.begin();
  let succeeded = false;
  try {
    const result = await runConfigureMutation(mutation, {
      scope: mutation.scope,
      agentId: mutation.owner.agentId,
      mode: "inherit",
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (mutation.isCurrent()) {
      mutation.applyStatus(
        result.value,
        { token: "", name: "", email: "" },
        result.refresh.ok ? null : result.refresh.error,
      );
      succeeded = true;
    }
  } catch (error) {
    if (mutation.isCurrent()) {
      mutation.setError(formatUiError(error));
    }
  } finally {
    mutation.finish(succeeded);
  }
}
