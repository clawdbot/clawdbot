// Agent identity draft state and persistence, split out of agents-page.ts.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationNavigationPreferences } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { updateAgentIdentity } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { fileToAvatarDataUrl } from "./avatar-image.ts";
import type { AgentIdentityDraft } from "./panels-overview.ts";

type AgentIdentityEditorHost = {
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityError: string | null;
};

const avatarSelectionEpochs = new WeakMap<AgentIdentityEditorHost, number>();

function advanceAvatarSelectionEpoch(host: AgentIdentityEditorHost): number {
  const epoch = (avatarSelectionEpochs.get(host) ?? 0) + 1;
  avatarSelectionEpochs.set(host, epoch);
  return epoch;
}

export function resetIdentityDraft(host: AgentIdentityEditorHost) {
  advanceAvatarSelectionEpoch(host);
  host.identityDraft = { name: null, emoji: null, avatar: null };
  host.identitySaving = false;
  host.identityError = null;
}

export function setIdentityDraftField(
  host: AgentIdentityEditorHost,
  field: "name" | "emoji",
  value: string,
) {
  host.identityDraft = { ...host.identityDraft, [field]: value };
  host.identityError = null;
}

export function selectIdentityAvatar(host: AgentIdentityEditorHost, file: File) {
  const epoch = advanceAvatarSelectionEpoch(host);
  void fileToAvatarDataUrl(file).then((dataUrl) => {
    if (avatarSelectionEpochs.get(host) !== epoch) {
      return;
    }
    if (dataUrl) {
      host.identityDraft = { ...host.identityDraft, avatar: dataUrl };
      host.identityError = null;
    } else {
      host.identityError = t("agents.identity.imageUnusable");
    }
  });
}

/** Mark avatar for clear on next save (`null` tombstone via agents.update). */
export function clearIdentityAvatar(host: AgentIdentityEditorHost) {
  advanceAvatarSelectionEpoch(host);
  host.identityDraft = { ...host.identityDraft, avatar: "" };
  host.identityError = null;
}

/** Persist the draft via agents.update, then refresh the roster and the
    identity cache so the sidebar chip and page pick up the new identity. */
export async function saveIdentityDraft(params: {
  host: AgentIdentityEditorHost;
  expectedClient: GatewayBrowserClient;
  agentId: string;
  agents: ApplicationContext["agents"];
  agentIdentity: ApplicationContext["agentIdentity"];
  runtimeConfig: ApplicationContext["runtimeConfig"];
  canDispatch: () => boolean;
  isCurrent: () => boolean;
  onSaved: () => void;
}) {
  const { host, expectedClient, agentId, agents, agentIdentity, runtimeConfig } = params;
  const draft = host.identityDraft;
  // Name stays set-only (blank name edits stay local). Emoji/avatar are
  // tri-state like model: omit preserves, null clears. Literal empty drafts
  // (including Remove-avatar's "") send the null tombstone; whitespace-only
  // drafts omit so Gateway keeps the stored value.
  const name = draft.name?.trim();
  if (draft.name !== null && !name) {
    return;
  }
  const emojiUpdate =
    draft.emoji === null
      ? undefined
      : draft.emoji.trim()
        ? draft.emoji.trim()
        : draft.emoji === ""
          ? null
          : undefined;
  const avatarUpdate =
    draft.avatar === null
      ? undefined
      : draft.avatar.trim()
        ? draft.avatar
        : draft.avatar === ""
          ? null
          : undefined;
  if (!name && emojiUpdate === undefined && avatarUpdate === undefined) {
    resetIdentityDraft(host);
    return;
  }
  host.identitySaving = true;
  host.identityError = null;
  try {
    const mutation = await runtimeConfig.runExternalMutation(
      (client) => {
        if (client !== expectedClient) {
          throw new Error("Connection changed before the agent identity update started.");
        }
        return updateAgentIdentity(client, {
          agentId,
          ...(name ? { name } : {}),
          ...(emojiUpdate !== undefined ? { emoji: emojiUpdate } : {}),
          ...(avatarUpdate !== undefined ? { avatar: avatarUpdate } : {}),
        });
      },
      {
        canDispatch: params.canDispatch,
        dispatchError: "Access changed before the agent identity update started.",
      },
    );
    if (!mutation.ok) {
      throw new Error(mutation.error);
    }
    const refreshErrors = mutation.refresh.ok ? [] : [mutation.refresh.error];
    agentIdentity.invalidate([agentId]);
    try {
      await agents.refreshList();
    } catch (error) {
      refreshErrors.push(
        `Agent identity was saved, but the agent list refresh failed: ${formatUiError(error)}`,
      );
    }
    try {
      await agentIdentity.ensure([agentId]);
    } catch (error) {
      refreshErrors.push(
        `Agent identity was saved, but the identity refresh failed: ${formatUiError(error)}`,
      );
    }
    if (params.isCurrent()) {
      resetIdentityDraft(host);
      params.onSaved();
      host.identityError = refreshErrors.length > 0 ? refreshErrors.join(" ") : null;
    }
  } catch (err) {
    if (params.isCurrent()) {
      host.identityError = formatUiError(err);
    }
  } finally {
    if (params.isCurrent()) {
      host.identitySaving = false;
    }
  }
}

/** Quick-switcher pin toggle; pins persist as browser-profile preferences. */
export function togglePinnedAgent(navigation: ApplicationNavigationPreferences, agentId: string) {
  const pinned = navigation.snapshot.pinnedAgentIds;
  const next = pinned.includes(agentId)
    ? pinned.filter((id) => id !== agentId)
    : [...pinned, agentId];
  navigation.update({ pinnedAgentIds: next });
}
