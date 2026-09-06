import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import {
  personActivityLink,
  renderPersonAvatarLink,
  renderPersonName,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";

export type ChatSessionSharingState = {
  loading: boolean;
  result?: SessionMembersListEvidenceResult;
  error?: string;
};

export type ChatSessionSharingProps = {
  session: GatewaySessionRow | undefined;
  state: ChatSessionSharingState | undefined;
  allowedVisibilities?: readonly SessionVisibility[];
  membersAvailable?: boolean;
  openDisabledReason?: string;
  visibilityDisabledReason?: string;
  memberAddDisabledReason?: string;
  memberRemoveDisabledReason?: string;
  publicShareDisabledReason?: string;
  onPublicShareChange?: (enabled: boolean) => void;
  onCopyPublicLink?: () => void;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  showOwner?: boolean;
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
    return icons.pencil;
  }
  return visibility === "shared" ? icons.users : icons.lock;
}

function renderMemberSkeletons() {
  return html`
    <div
      class="chat-pane__sharing-members-loading"
      role="status"
      aria-busy="true"
      aria-label=${t("common.loading")}
    >
      ${Array.from(
        { length: 3 },
        () => html`
          <div class="chat-pane__sharing-member-skeleton" aria-hidden="true">
            <span class="skeleton chat-pane__sharing-member-skeleton-icon"></span>
            <span class="skeleton chat-pane__sharing-member-skeleton-label"></span>
          </div>
        `,
      )}
    </div>
  `;
}

export function selectChatSessionSharingItem(
  props: ChatSessionSharingProps,
  value: string | undefined,
): void {
  if (value?.startsWith("public:")) {
    if (
      !props.session ||
      !canManageChatSessionSharing(props.session) ||
      props.state?.loading ||
      !props.state?.result
    ) {
      return;
    }
    if (value === "public:copy" && props.state.result.publicShare) {
      props.onCopyPublicLink?.();
    } else if (!props.publicShareDisabledReason) {
      if (value === "public:enable") {
        props.onPublicShareChange?.(true);
      } else if (value === "public:disable") {
        props.onPublicShareChange?.(false);
      }
    }
    return;
  }
  const members = new Set(props.state?.result?.members.map((member) => member.identityId) ?? []);
  if (value?.startsWith("visibility:")) {
    const visibility = value.slice("visibility:".length) as SessionVisibility;
    if (!props.visibilityDisabledReason && visibility !== (props.session?.visibility ?? "shared")) {
      props.onVisibilityChange(visibility);
    }
    return;
  }
  if (!value?.startsWith("member:")) {
    return;
  }
  const identityId = value.slice("member:".length);
  const member = !members.has(identityId);
  const disabledReason = member ? props.memberAddDisabledReason : props.memberRemoveDisabledReason;
  if (!disabledReason) {
    props.onMemberChange(identityId, member);
  }
}

export function canManageChatSessionSharing(
  session: Pick<GatewaySessionRow, "sharingRole">,
): boolean {
  return session.sharingRole === "admin" || session.sharingRole === "owner";
}

export function renderChatSessionPublicIndicator(props: ChatSessionSharingProps) {
  if (!props.state?.result?.publicShare) {
    return nothing;
  }
  const description = t("chat.sessionSharing.worldReadable");
  return html`<span
    class="chat-pane__public-share-indicator"
    role="status"
    aria-label=${description}
    title=${description}
  >
    <span aria-hidden="true">${icons.globe}</span>
    <span>${t("chat.sessionSharing.publicIndicator")}</span>
  </span>`;
}

export function renderChatSessionSharing(props: ChatSessionSharingProps, inline = false) {
  const session = props.session;
  if (!session) {
    return nothing;
  }
  const visibility = session.visibility ?? "shared";
  const canManage = canManageChatSessionSharing(session);
  const result = props.state?.result;
  const publicShare = result?.publicShare;
  const owner = result?.owner ?? session.owner?.actor;
  const ownerActivity = personActivityLink(
    owner?.identity?.type === "profile" ? owner.identity.id : undefined,
    props.personActivity,
    owner?.label,
  );
  if (!canManage) {
    return visibility === "draft"
      ? html`${
            props.showOwner && owner
              ? renderStandalonePersonLink(
                  renderSessionOwnerChip(owner, "header", "owned", props.ownerViewing),
                  ownerActivity,
                )
              : nothing
          }<span class="chat-pane__draft-indicator" title=${t("chat.sessionSharing.draft")}
            >${sharingIcon("draft")}</span
          >`
      : nothing;
  }
  const members = new Set(result?.members.map((member) => member.identityId) ?? []);
  // The owner row presents effective ownership; selectable rows below manage mutable members.
  const identities =
    result?.identities.filter((identity) => identity.id !== result.owner?.id) ?? [];
  const allowed = result?.allowedVisibilities ?? props.allowedVisibilities ?? [visibility];
  const canPublish = visibility === "draft" && allowed.includes("shared");
  const membersAvailable = props.membersAvailable !== false;
  const visibilityOptions = allowed.filter((option) => !canPublish || option !== "shared");
  const shouldCapMembers =
    membersAvailable &&
    visibilityOptions.length + identities.length + (canPublish ? 1 : 0) + (owner ? 1 : 0) > 12;
  const content = html`
    ${
      canPublish
        ? html`<wa-dropdown-item
              value="visibility:shared"
              class="session-menu__item chat-pane__publish-draft"
              ?disabled=${Boolean(props.visibilityDisabledReason)}
              title=${props.visibilityDisabledReason ?? nothing}
            >
              <span class="session-menu__text">${t("chat.sessionSharing.publishDraft")}</span>
              <span slot="details" aria-hidden="true">${icons.users}</span>
            </wa-dropdown-item>
            <div class="session-menu__separator" role="separator"></div>`
        : nothing
    }
    <div class="chat-pane__sharing-title chat-pane__sharing-visibility-title">
      ${t("chat.sessionSharing.visibility")}
    </div>
    ${visibilityOptions.map((option) => {
      const checked = option === visibility;
      return html`
        <wa-dropdown-item
          class="session-menu__item chat-pane__sharing-visibility-item"
          value=${`visibility:${option}`}
          role="menuitemradio"
          aria-checked=${String(checked)}
          ${ref((element) => syncDropdownItemRadio(element, checked))}
          ?disabled=${Boolean(props.visibilityDisabledReason)}
          title=${props.visibilityDisabledReason ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${sharingIcon(option)}</span
          >
          <span class="session-menu__text">${t(VISIBILITY_LABEL_KEYS[option])}</span>
          ${
            checked
              ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                  >${icons.check}</span
                >`
              : nothing
          }
        </wa-dropdown-item>
      `;
    })}
    ${
      props.onPublicShareChange
        ? html`
            <div class="session-menu__separator" role="separator"></div>
            <div class="chat-pane__sharing-title">${t("chat.sessionSharing.publicAccess")}</div>
            <div class="chat-pane__sharing-status">
              ${t(
                props.state?.loading || !result
                  ? "common.loading"
                  : publicShare
                    ? "chat.sessionSharing.worldReadable"
                    : "chat.sessionSharing.notPublic",
              )}
            </div>
            ${
              publicShare
                ? html`<wa-dropdown-item
                    class="session-menu__item"
                    value="public:copy"
                    ?disabled=${Boolean(props.state?.loading)}
                    >${t("chat.sessionSharing.copyPublicLink")}</wa-dropdown-item
                  >`
                : nothing
            }
            <wa-dropdown-item
              class="session-menu__item"
              value=${publicShare ? "public:disable" : "public:enable"}
              ?disabled=${Boolean(props.publicShareDisabledReason || props.state?.loading || !result)}
              title=${props.publicShareDisabledReason ?? nothing}
            >
              ${t(
                publicShare
                  ? "chat.sessionSharing.disablePublicAccess"
                  : "chat.sessionSharing.enablePublicAccess",
              )}
            </wa-dropdown-item>
          `
        : nothing
    }
    ${
      owner
        ? html`
            <div class="chat-pane__sharing-title chat-pane__sharing-owner-title">
              ${t("chat.sessionSharing.owner")}
            </div>
            <div class="chat-pane__sharing-owner">
              <span class="chat-pane__sharing-member-icon" aria-hidden="true">
                ${
                  owner.type === "human"
                    ? renderPersonAvatarLink(
                        renderSessionOwnerChip(owner, "header", "owned", props.ownerViewing),
                        ownerActivity,
                      )
                    : icons.bot
                }
              </span>
              ${renderPersonName(
                owner.label ?? owner.id ?? t("chat.sessionSharing.owner"),
                ownerActivity,
                "session-menu__text",
              )}
            </div>
          `
        : nothing
    }
    ${
      membersAvailable
        ? html`
            <div class="chat-pane__sharing-title chat-pane__sharing-members-title">
              ${t("chat.sessionSharing.members")}
            </div>
            ${
              props.state?.loading
                ? renderMemberSkeletons()
                : identities.length > 0
                  ? identities.map((identity) => {
                      const disabledReason = members.has(identity.id)
                        ? props.memberRemoveDisabledReason
                        : props.memberAddDisabledReason;
                      return html`
                        <wa-dropdown-item
                          class="session-menu__item chat-pane__sharing-member"
                          value=${`member:${identity.id}`}
                          ?disabled=${Boolean(disabledReason)}
                          title=${disabledReason ?? nothing}
                        >
                          <span
                            slot="icon"
                            class="chat-pane__sharing-member-icon"
                            aria-hidden="true"
                          >
                            ${
                              identity.type === "human"
                                ? renderSessionOwnerChip(identity, "header")
                                : icons.bot
                            }
                          </span>
                          <span
                            class="session-menu__text chat-pane__sharing-member-label"
                            title=${disabledReason ? nothing : (identity.label ?? identity.id)}
                            >${identity.label ?? identity.id}</span
                          >
                          ${
                            members.has(identity.id)
                              ? html`<span
                                  slot="details"
                                  class="session-menu__check"
                                  aria-label=${t("chat.sessionSharing.selected")}
                                  >${icons.check}</span
                                >`
                              : nothing
                          }
                        </wa-dropdown-item>
                      `;
                    })
                  : html`<div class="chat-pane__sharing-status">
                      ${t("chat.sessionSharing.noPeople")}
                    </div>`
            }
          `
        : nothing
    }
    ${
      props.state?.error
        ? html`<div class="chat-pane__sharing-status chat-pane__sharing-status--error" role="alert">
            ${props.state.error}
          </div>`
        : nothing
    }
  `;
  if (inline) {
    return content;
  }
  return html`
    ${renderChatSessionPublicIndicator(props)}
    <wa-dropdown
      class="chat-pane__sharing-menu ${shouldCapMembers ? "chat-pane__sharing-menu--capped" : ""}"
      placement="bottom-end"
      @wa-show=${() => {
        if (!props.openDisabledReason) {
          props.onOpen();
        }
      }}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        selectChatSessionSharingItem(props, event.detail.item.value);
      }}
    >
      <button
        slot="trigger"
        class="btn btn--ghost btn--icon chat-icon-btn chat-pane__sharing-trigger"
        type="button"
        aria-label=${t("chat.sessionSharing.menu")}
        ?disabled=${Boolean(props.openDisabledReason)}
        title=${
          props.openDisabledReason ??
          t("chat.sessionSharing.current", {
            visibility: t(VISIBILITY_LABEL_KEYS[visibility]),
          })
        }
      >
        ${sharingIcon(visibility)}
      </button>
      ${content}
    </wa-dropdown>
  `;
}
