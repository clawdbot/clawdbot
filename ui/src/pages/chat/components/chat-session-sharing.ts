import { html, nothing, type TemplateResult } from "lit";
import type {
  GatewaySessionRow,
  SessionMembersListResult,
  SessionVisibility,
} from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";

export type ChatSessionSharingState = {
  loading: boolean;
  result?: SessionMembersListResult;
  error?: string;
};

type ChatSessionSharingProps = {
  session: GatewaySessionRow | undefined;
  state: ChatSessionSharingState | undefined;
  onOpen: () => void;
  onVisibilityChange: (visibility: SessionVisibility) => void;
  onMemberChange: (identityId: string, member: boolean) => void;
};

const VISIBILITY_LABEL_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.shared",
  "read-only": "chat.sessionSharing.readOnly",
  suggest: "chat.sessionSharing.suggest",
  draft: "chat.sessionSharing.draft",
};

function sharingIcon(visibility: SessionVisibility): TemplateResult {
  if (visibility === "draft") {
    return html`<span aria-hidden="true">👻</span>`;
  }
  return visibility === "shared" ? icons.users : icons.lock;
}

export function renderChatSessionSharing(props: ChatSessionSharingProps) {
  const session = props.session;
  if (!session) {
    return nothing;
  }
  const visibility = session.visibility ?? "shared";
  const canManage = session.sharingRole === "admin" || session.sharingRole === "owner";
  if (!canManage) {
    return visibility === "draft"
      ? html`<span class="chat-pane__draft-indicator" title=${t("chat.sessionSharing.draft")}
          >👻</span
        >`
      : nothing;
  }
  const result = props.state?.result;
  const members = new Set(result?.members.map((member) => member.identityId) ?? []);
  // The shared header owner chip presents createdActor; this picker only manages mutable members.
  const identities =
    result?.identities.filter((identity) => identity.id !== result.owner?.id) ?? [];
  const allowed = result?.allowedVisibilities ?? [visibility];
  const canPublish = visibility === "draft" && allowed.includes("shared");
  return html`
    <wa-dropdown
      class="chat-pane__sharing-menu"
      placement="bottom-end"
      @wa-show=${props.onOpen}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const value = event.detail.item.value;
        if (value?.startsWith("visibility:")) {
          props.onVisibilityChange(value.slice("visibility:".length) as SessionVisibility);
          return;
        }
        if (value?.startsWith("member:")) {
          const identityId = value.slice("member:".length);
          props.onMemberChange(identityId, !members.has(identityId));
        }
      }}
    >
      <button
        slot="trigger"
        class="btn btn--ghost btn--icon chat-icon-btn chat-pane__sharing-trigger"
        type="button"
        aria-label=${t("chat.sessionSharing.menu")}
        title=${t("chat.sessionSharing.current", {
          visibility: t(VISIBILITY_LABEL_KEYS[visibility]),
        })}
      >
        ${sharingIcon(visibility)}
      </button>
      ${canPublish
        ? html`<wa-dropdown-item value="visibility:shared" class="chat-pane__publish-draft">
              <span>${t("chat.sessionSharing.publishDraft")}</span>
              <span slot="details" aria-hidden="true">${icons.users}</span>
            </wa-dropdown-item>
            <div class="session-menu__separator" role="separator"></div>`
        : nothing}
      <div class="chat-pane__sharing-title">${t("chat.sessionSharing.visibility")}</div>
      ${allowed
        .filter((option) => !canPublish || option !== "shared")
        .map(
          (option) => html`
            <wa-dropdown-item value=${`visibility:${option}`} ?disabled=${option === visibility}>
              <span>${t(VISIBILITY_LABEL_KEYS[option])}</span>
              ${option === visibility
                ? html`<span slot="details" aria-hidden="true">${icons.check}</span>`
                : nothing}
            </wa-dropdown-item>
          `,
        )}
      <div class="session-menu__separator" role="separator"></div>
      <div class="chat-pane__sharing-title">${t("chat.sessionSharing.members")}</div>
      ${props.state?.loading
        ? html`<div class="chat-pane__sharing-status">${t("common.loading")}</div>`
        : identities.length > 0
          ? identities.map(
              (identity) => html`
                <wa-dropdown-item value=${`member:${identity.id}`}>
                  <span>${identity.label ?? identity.id}</span>
                  ${members.has(identity.id)
                    ? html`<span slot="details" aria-label=${t("chat.sessionSharing.selected")}
                        >${icons.check}</span
                      >`
                    : nothing}
                </wa-dropdown-item>
              `,
            )
          : html`<div class="chat-pane__sharing-status">${t("chat.sessionSharing.noPeople")}</div>`}
      ${props.state?.error
        ? html`<div class="chat-pane__sharing-status chat-pane__sharing-status--error">
            ${props.state.error}
          </div>`
        : nothing}
    </wa-dropdown>
  `;
}
