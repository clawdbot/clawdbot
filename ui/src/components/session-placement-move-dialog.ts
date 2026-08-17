import { html, nothing, render } from "lit";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  renderCloudProfileMenuItems,
  renderSessionMenuItem,
} from "../pages/new-session/cloud-target.ts";
import type { DraftCloudProfile, DraftNode } from "../pages/new-session/discovery.ts";
import { isDraftNodeSessionEligible } from "../pages/new-session/discovery.ts";
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
      finish(selected);
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
                              ${renderCloudProfileMenuItems({
                                profiles: catalog.profiles,
                                selectedId: selected.kind === "profile" ? selected.profileId : "",
                                submitting: false,
                                icon: icons.server,
                                onSelect: (profileId) => select({ kind: "profile", profileId }),
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
