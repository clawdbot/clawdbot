import { html, nothing } from "lit";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { readDraftCloudProfiles } from "./discovery.ts";

export async function requestCloudProfiles(
  client: Pick<GatewayBrowserClient, "request">,
): Promise<DraftCloudProfile[]> {
  const result = await client.request<EnvironmentsListResult>("environments.list", {});
  return readDraftCloudProfiles(result?.profiles);
}

type SessionMenuItemOptions = {
  value: string;
  label: string;
  icon?: unknown;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  onSelect: () => void;
};

export function renderSessionMenuItem(params: SessionMenuItemOptions, submitting: boolean) {
  return html`
    <button
      type="button"
      class="session-menu__item"
      data-value=${params.value}
      data-popover=${params.keepOpen ? nothing : "close"}
      aria-pressed=${String(params.checked)}
      title=${params.title ?? nothing}
      ?disabled=${submitting || (params.disabled ?? false)}
      @click=${params.onSelect}
    >
      ${params.icon
        ? html`<span class="session-menu__icon" aria-hidden="true">${params.icon}</span>`
        : nothing}
      <span class="session-menu__text">${params.label}</span>
      ${params.sub ? html`<span class="session-menu__sub">${params.sub}</span>` : nothing}
      <span class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
    </button>
  `;
}

export function renderCloudProfileMenuItems(params: {
  profiles: DraftCloudProfile[];
  selectedId: string;
  submitting: boolean;
  icon?: unknown;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (profileId: string) => void;
}) {
  return params.profiles.map((profile) =>
    renderSessionMenuItem(
      {
        value: `cloud:${profile.id}`,
        label: t("newSession.cloudWorker", { profile: profile.id }),
        icon: params.icon,
        checked: params.selectedId === profile.id,
        disabled: params.disabled,
        title:
          params.disabled && params.disabledReason
            ? params.disabledReason
            : t("newSession.cloudWorkerProvider", { provider: profile.providerId }),
        onSelect: () => params.onSelect(profile.id),
      },
      params.submitting,
    ),
  );
}
