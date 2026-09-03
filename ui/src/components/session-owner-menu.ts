import { ContextConsumer } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing, type ReactiveControllerHost } from "lit";
import { ref } from "lit/directives/ref.js";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { buildControlUiUserAvatarPath } from "../../../src/gateway/control-ui-user-avatar-route.js";
import { applicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentTargetLabel } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { formatUiError } from "../lib/format-error.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { icons } from "./icons.ts";
import {
  renderSessionOwnerAvatar,
  sessionSelfOwner,
  type SessionCreatedActor,
  type SessionOwnerOption,
} from "./session-owner-chip.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionOwnerMenuParams = {
  currentOwner: SessionCreatedActor | null;
  disabled: boolean;
  disabledReason?: string;
};

/** Assignment uses the Gateway directory, independently of session filters and presence. */
export class SessionOwnerMenu {
  private readonly context;
  private readonly profiles;
  private opened = false;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.context = new ContextConsumer(host, { context: applicationContext, subscribe: true });
    // Bind the Gateway before Task reads its epoch, so reconnects and source replacements
    // retire stale directory replies before the menu renders.
    const connection = new GatewayPageController(host, {
      getGateway: () => this.context.value?.gateway,
    });
    this.profiles = new Task(host, {
      args: () => [connection.epoch, this.opened, connection.capture()?.client] as const,
      task: ([, opened, client]) =>
        opened && client ? client.request<UsersListResult>("users.list", {}) : initialState,
    });
  }

  readonly load = () => {
    this.opened = true;
    void this.profiles.run();
  };

  render(params: SessionOwnerMenuParams, inline = false) {
    const context = this.context.value;
    const self = sessionSelfOwner(context?.gateway.snapshot.selfUser);
    const currentOwner = params.currentOwner;
    const currentOwnerId = currentOwner?.identity?.id ?? currentOwner?.id;
    // The session already records its owner; directory availability must not erase the checked row.
    const owners: SessionOwnerOption[] =
      this.profiles.status === TaskStatus.COMPLETE
        ? (this.profiles.value?.profiles ?? [])
            .filter((profile) => !profile.mergedInto && profile.id !== self?.id)
            .map((profile) => ({
              type: "human",
              id: profile.id,
              identity: { type: "profile", id: profile.id },
              label:
                profile.displayName?.trim() ||
                profile.githubIdentity?.login ||
                profile.emails[0] ||
                profile.id,
              avatarUrl: buildControlUiUserAvatarPath(profile.id, profile.updatedAt),
            }))
        : currentOwner?.type === "human" && currentOwnerId && currentOwnerId !== self?.id
          ? [{ ...currentOwner, type: currentOwner.type, id: currentOwnerId }]
          : [];
    for (const agent of context?.agents.state.agentsList?.agents ?? []) {
      const identity = context?.agentIdentity.get(agent.id);
      owners.push({
        type: "agent",
        id: agent.id,
        identity: { type: "agent", id: agent.id },
        label: normalizeAgentTargetLabel(agent, identity),
        avatarUrl: resolveAgentAvatarUrl(agent, identity) ?? undefined,
      });
    }
    owners.sort(
      (left, right) =>
        left.type.localeCompare(right.type) ||
        (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
        left.id.localeCompare(right.id),
    );
    if (self) {
      owners.unshift(self);
    }
    const slot = inline ? nothing : "submenu";
    return html`
      ${owners.map((owner) => {
        const checked = owner.type === currentOwner?.type && owner.id === currentOwnerId;
        return html`<wa-dropdown-item
          slot=${slot}
          class="session-menu__item"
          value=${`assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`}
          role="menuitemradio"
          aria-checked=${String(checked)}
          ${ref((element) => syncDropdownItemRadio(element, checked))}
          ?disabled=${params.disabled || checked}
          title=${params.disabledReason ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${renderSessionOwnerAvatar(owner)}</span
          >
          <span class="session-menu__text"
            >${owner === self ? t("sessionsView.assignToMe") : (owner.label ?? owner.id)}</span
          >
          ${checked
            ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                >${icons.check}</span
              >`
            : nothing}
        </wa-dropdown-item>`;
      })}
      ${this.profiles.render({
        pending: () =>
          html`<wa-dropdown-item slot=${slot} disabled>${t("common.loading")}</wa-dropdown-item>`,
        error: (error) => html`
          <div slot=${slot} class="session-menu__info" role="alert">
            ${formatUiError(error, t("common.failed"))}
          </div>
          <wa-dropdown-item slot=${slot} class="session-menu__item" value="reload-owners"
            >${t("common.retry")}</wa-dropdown-item
          >
        `,
      })}
    `;
  }
}
