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

const avatarSelections = new WeakMap<AgentIdentityEditorHost, Promise<string | null>>();

export function resetIdentityDraft(host: AgentIdentityEditorHost) {
  avatarSelections.delete(host);
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
  const selection = fileToAvatarDataUrl(file).then((dataUrl) => {
    if (avatarSelections.get(host) !== selection) {
      return null;
    }
    avatarSelections.delete(host);
    if (dataUrl) {
      host.identityDraft = { ...host.identityDraft, avatar: dataUrl };
      host.identityError = null;
    } else {
      host.identityError = t("agents.identity.imageUnusable");
    }
    return dataUrl;
  });
  avatarSelections.set(host, selection);
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
  host.identitySaving = true;
  host.identityError = null;
  try {
    // A picked image is part of this save even before decoding publishes its
    // draft. Failed or retired conversions must not become partial saves.
    const selection = avatarSelections.get(host);
    if (selection && !(await selection)) {
      return;
    }
    if (!params.isCurrent()) {
      return;
    }
    const draft = host.identityDraft;
    // Set/replace only: agents.update has no explicit clear operation. Keep a
    // blank edit visible and unsaved instead of pretending it removed a field.
    const name = draft.name?.trim();
    const emoji = draft.emoji?.trim();
    const avatar = draft.avatar ?? undefined;
    if ((draft.name !== null && !name) || (draft.emoji !== null && !emoji)) {
      return;
    }
    if (!name && !emoji && !avatar) {
      resetIdentityDraft(host);
      return;
    }
    const mutation = await runtimeConfig.runExternalMutation(
      (client) => {
        if (client !== expectedClient) {
          throw new Error("Connection changed before the agent identity update started.");
        }
        return updateAgentIdentity(client, { agentId, name, emoji, avatar });
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
