import { html, nothing, render } from "lit";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  renderCloudMachineMenuItems,
  renderCloudProfileMenuItems,
  renderSessionMenuItem,
} from "../pages/new-session/cloud-target.ts";
import type { DraftCloudProfile, DraftNode } from "../pages/new-session/discovery.ts";
import { isDraftNodeSessionEligible } from "../pages/new-session/discovery.ts";
import { DraftCloudMachineState } from "../pages/new-session/draft-cloud-machine-state.ts";
import "../styles/new-session.css";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

type Catalog = {
  profiles: readonly DraftCloudProfile[];
  nodes: readonly DraftNode[];
};

type Options = {
  sessionLabel: string;
  activeRun: boolean;
  loadCatalog: () => Promise<Catalog>;
};

let active = false;

function targetKey(target: SessionMoveTarget): string {
  switch (target.kind) {
    case "gateway":
      return "gateway";
    case "profile":
      return `profile:${target.profileId}`;
    case "device":
      return `device:${target.deviceId}`;
  }
  throw new Error("Unknown session placement move target");
}

export function showSessionPlacementMoveDialog(
  options: Options,
): Promise<SessionMoveTarget | null> {
  if (active) {
    return Promise.resolve(null);
  }
  active = true;
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    let loading = true;
    let loadError: string | null = null;
    let catalog: Catalog = { profiles: [], nodes: [] };
    let selected: SessionMoveTarget = { kind: "gateway" };
    const cloudMachines = new DraftCloudMachineState();

    const finish = (result: SessionMoveTarget | null) => {
      render(nothing, host);
      host.remove();
      active = false;
      resolve(result);
    };

    const select = (target: SessionMoveTarget) => {
      selected = target;
      paint();
    };

    const submit = (event: Event) => {
      event.preventDefault();
      if (selected.kind !== "profile") {
        finish(selected);
        return;
      }
      const machineClass = cloudMachines.resolve(selected.profileId);
      finish({
        ...selected,
        ...(machineClass ? { machineClass } : {}),
      });
    };

    function paint() {
      const selectedKey = targetKey(selected);
      const nodes = catalog.nodes.filter(isDraftNodeSessionEligible);
      render(
        html`
          <openclaw-modal-dialog
            label=${t("sessionsView.moveSessionTitle")}
            @modal-cancel=${() => finish(null)}
          >
            <form class="exec-approval-card" @submit=${submit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">${t("sessionsView.moveSessionTitle")}</div>
                <div class="muted">
                  ${t("sessionsView.moveSessionDescription", { session: options.sessionLabel })}
                </div>
              </div>
              ${options.activeRun
                ? html`<div class="exec-approval-error" role="alert">
                    ${t("sessionsView.moveSessionActiveRunWarning")}
                  </div>`
                : html`<div class="callout">${t("sessionsView.moveSessionNoReplayWarning")}</div>`}
              ${loading
                ? html`<div class="muted">${t("common.loading")}</div>`
                : loadError
                  ? html`<div class="exec-approval-error" role="alert">${loadError}</div>`
                  : html`
                      <div class="new-session-page__picker-root">
                        ${renderSessionMenuItem(
                          {
                            value: "gateway",
                            label: t("newSession.gateway"),
                            icon: icons.monitor,
                            checked: selectedKey === "gateway",
                            onSelect: () => select({ kind: "gateway" }),
                          },
                          false,
                        )}
                        ${nodes.length > 0
                          ? html`
                              <div class="new-session-page__menu-title">
                                ${t("newSession.yourDevices")}
                              </div>
                              ${nodes.map((node) =>
                                renderSessionMenuItem(
                                  {
                                    value: `device:${node.nodeId}`,
                                    label: node.displayName,
                                    icon: icons.monitor,
                                    checked: selectedKey === `device:${node.nodeId}`,
                                    onSelect: () =>
                                      select({ kind: "device", deviceId: node.nodeId }),
                                  },
                                  false,
                                ),
                              )}
                            `
                          : nothing}
                        ${catalog.profiles.length > 0
                          ? html`
                              <div class="new-session-page__menu-title">
                                ${t("newSession.cloud")}
                              </div>
                              ${catalog.profiles.map((profile) => {
                                const profileSelected =
                                  selected.kind === "profile" && selected.profileId === profile.id;
                                const machines = profile.machines ?? [];
                                const selectedMachineId =
                                  cloudMachines.resolve(profile.id) ||
                                  machines.find((machine) => machine.default === true)?.id ||
                                  "";
                                return html`
                                  ${renderCloudProfileMenuItems({
                                    profiles: [profile],
                                    selectedId: profileSelected ? profile.id : "",
                                    submitting: false,
                                    icon: icons.server,
                                    onSelect: (profileId) => select({ kind: "profile", profileId }),
                                  })}
                                  ${profileSelected && machines.length > 0
                                    ? html`
                                        <div class="new-session-page__menu-title">
                                          ${t("newSession.machine")}
                                        </div>
                                        ${renderCloudMachineMenuItems({
                                          machines,
                                          selectedId: selectedMachineId,
                                          submitting: false,
                                          onSelect: (machineId) =>
                                            cloudMachines.select(
                                              profile.id,
                                              machineId,
                                              catalog.profiles,
                                              false,
                                              paint,
                                            ),
                                        })}
                                      `
                                    : nothing}
                                `;
                              })}
                            `
                          : nothing}
                      </div>
                    `}
              <div class="exec-approval-actions">
                <button
                  type="submit"
                  class="btn primary"
                  ?disabled=${loading || Boolean(loadError)}
                >
                  ${t("sessionsView.moveSessionAction")}
                </button>
                <button type="button" class="btn" @click=${() => finish(null)}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `,
        host,
      );
    }

    paint();
    void options
      .loadCatalog()
      .then((loaded) => {
        catalog = loaded;
      })
      .catch((error: unknown) => {
        loadError = formatUiError(error, t("sessionsView.moveSessionCatalogFailed"));
      })
      .finally(() => {
        loading = false;
        paint();
      });
  });
}
