import { html, nothing } from "lit";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { DraftCloudProfile, DraftEnvironment, DraftMachineOption } from "./discovery.ts";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
): Promise<{ profiles: DraftCloudProfile[]; environments: DraftEnvironment[] }> {
  const result = await client.request<EnvironmentsListResult>("environments.list", {});
  return {
    profiles: readDraftCloudProfiles(result?.profiles),
    environments: readDraftEnvironments(result?.environments),
  };
}

type SessionMenuItemOptions = {
  value: string;
  label: string;
  icon?: unknown;
  sub?: string;
  facts?: readonly string[];
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
      ${params.facts?.length
        ? html`<span class="new-session-page__menu-facts">
            ${params.facts.map(
              (fact) => html`<span class="new-session-page__menu-fact">${fact}</span>`,
            )}
          </span>`
        : nothing}
      ${params.sub ? html`<span class="session-menu__sub">${params.sub}</span>` : nothing}
      <span class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
    </button>
  `;
}

export function renderConnectMachineMenuItem(params: { disabled: boolean; onSelect: () => void }) {
  return html`
    <div class="session-menu__separator" role="separator"></div>
    <button
      type="button"
      class="session-menu__item new-session-page__connect-machine"
      data-value="connect-machine"
      aria-pressed="false"
      ?disabled=${params.disabled}
      @click=${params.onSelect}
    >
      <span class="session-menu__icon" aria-hidden="true">${icons.link}</span>
      <span class="session-menu__text">${t("newSession.connectMachine")}</span>
    </button>
  `;
}

export function renderCloudProfileMenuItems(params: {
  profiles: readonly DraftCloudProfile[];
  selectedId: string;
  submitting: boolean;
  icon?: unknown;
  disabled?: boolean;
  disabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  onSelect: (profileId: string) => void;
}) {
  return params.profiles.map((profile) => {
    const profileDisabledReason = params.profileDisabledReason?.(profile);
    return renderSessionMenuItem(
      {
        value: `cloud:${profile.id}`,
        label: t("newSession.cloudWorker", { profile: profile.id }),
        icon: params.icon,
        facts:
          profile.trust === "disposable"
            ? [t("newSession.environmentDisposable")]
            : profile.trust === "persistent"
              ? [t("newSession.environmentPersistent")]
              : undefined,
        checked: params.selectedId === profile.id,
        disabled: params.disabled || Boolean(profileDisabledReason),
        title:
          (params.disabled ? params.disabledReason : profileDisabledReason) ??
          t("newSession.cloudWorkerProvider", { provider: profile.providerId }),
        onSelect: () => params.onSelect(profile.id),
      },
      params.submitting,
    );
  });
}

/** Machine shape as a picker sub-line; providers may report neither, one, or both numbers. */
function machineShapeText(machine: DraftMachineOption): string | undefined {
  const cpu = machine.cpu === undefined ? undefined : String(machine.cpu);
  const memory = machine.memoryGb === undefined ? undefined : String(machine.memoryGb);
  if (cpu && memory) {
    return t("newSession.machineShape", { cpu, memory });
  }
  if (cpu) {
    return t("newSession.machineCpu", { cpu });
  }
  return memory ? t("newSession.machineMemory", { memory }) : undefined;
}

export function renderCloudMachineMenuItems(params: {
  machines: readonly DraftMachineOption[];
  selectedId: string;
  submitting: boolean;
  onSelect: (machineId: string) => void;
}) {
  return params.machines.map((machine) =>
    renderSessionMenuItem(
      {
        value: `machine:${machine.id}`,
        label: machine.label,
        sub: machineShapeText(machine),
        facts: machine.default ? [t("newSession.machineDefault")] : undefined,
        checked: params.selectedId === machine.id,
        keepOpen: true,
        onSelect: () => params.onSelect(machine.id),
      },
      params.submitting,
    ),
  );
}
