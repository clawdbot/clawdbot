import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../../pages/config/settings-targets.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import {
  renderGitHubConnectionSetup,
  renderGitHubDetails,
  renderGitHubHealth,
} from "./github-identity-view.ts";

/** Profile credentials have their own read-scoped lifecycle, independent of users.self edits. */
export class GitHubConnections extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @state() private purpose: "personal" | "system" = "personal";
  @state() private setupOpen = false;
  private snapshot: ApplicationGatewaySnapshot | null = null;
  private revision = 0;
  private canRead = false;
  private canAdmin = false;
  private profileId: string | null = null;
  private subscriptions: Array<() => void> = [];
  private readonly personal = new GitHubIdentityController({
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly system = new GitHubIdentityController({
    requestUpdate: () => this.requestUpdate(),
    runExternalMutation: (task, options) =>
      this.context.runtimeConfig.runExternalMutation(task, options),
  });

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applySnapshot(snapshot)),
      this.context.agents.subscribe(() => this.syncControllers()),
      this.context.runtimeConfig.subscribe(() => this.syncControllers()),
    ];
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.personal.dispose();
    this.system.dispose();
    this.snapshot = null;
    this.revision += 1;
    super.disconnectedCallback();
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const previous = this.snapshot;
    const changed =
      !previous ||
      previous.client !== snapshot.client ||
      previous.phase !== snapshot.phase ||
      previous.hello !== snapshot.hello ||
      this.profileId !== (snapshot.selfUser?.id ?? null);
    this.snapshot = snapshot;
    this.profileId = snapshot.phase === "connected" ? (snapshot.selfUser?.id ?? null) : null;
    // Access comes from the authenticated connection, never an error from users.github.status.
    this.canRead =
      snapshot.phase === "connected" &&
      Boolean(snapshot.hello?.auth) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    this.canAdmin = this.canRead && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (changed) {
      this.revision += 1;
      this.setupOpen = false;
      this.purpose = this.profileId ? "personal" : "system";
    }
    this.syncControllers();
    if (this.canAdmin) {
      void this.context.runtimeConfig.ensureLoaded();
    }
  }

  private syncControllers() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const common = {
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      clientRevision: this.revision,
    };
    this.personal.sync({
      ...common,
      target: this.profileId ? { kind: "personal", profileId: this.profileId } : null,
      statusReadable: this.canRead && this.profileId !== null,
      authorizable: this.canRead && this.profileId !== null,
      configurable: false,
    });
    const agentId = this.context.agents.state.agentsList?.defaultId;
    this.system.sync({
      ...common,
      target: agentId
        ? {
            kind: "shared",
            scope: "system",
            agentId,
            config: currentConfigObject(this.context.runtimeConfig.state),
          }
        : null,
      statusReadable: this.canAdmin,
      authorizable: this.canAdmin,
      configurable: this.canAdmin,
    });
    if (
      this.personal.statusReadable &&
      !this.personal.personal &&
      !this.personal.loading &&
      !this.personal.error
    ) {
      void this.personal.verify();
    }
    if (
      agentId &&
      this.canAdmin &&
      !this.system.status &&
      !this.system.loading &&
      !this.system.error
    ) {
      void this.system.verify();
    }
    this.requestUpdate();
  }

  private get locked() {
    return (
      this.personal.loading ||
      this.system.loading ||
      this.personal.authorizationActive ||
      this.system.authorizationActive ||
      this.personal.busy ||
      this.system.busy
    );
  }

  private openSetup(purpose: "personal" | "system") {
    if (
      this.locked ||
      (purpose === "personal" ? !this.profileId || !this.canRead : !this.canAdmin)
    ) {
      return;
    }
    this.purpose = purpose;
    this.setupOpen = true;
  }

  override render() {
    const personal = this.personal.personal;
    const system = this.system.status?.selected.identity ?? this.personal.system;
    const active = this.purpose === "personal" ? this.personal : this.system;
    const showSetup =
      this.setupOpen || this.personal.authorizationActive || this.system.authorizationActive;
    const connected = personal?.state === "connected";
    const reconnectRequired =
      personal?.state === "unavailable" ||
      personal?.refreshState === "expired" ||
      personal?.refreshState === "failed";
    const personalLabel = !this.profileId
      ? t("githubConnections.signInRequired")
      : reconnectRequired
        ? t("githubConnections.reconnectRequired")
        : connected
          ? t("githubConnections.connected")
          : personal
            ? t("githubConnections.disconnected")
            : t("githubConnections.notLoaded");
    return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.githubConnections}>
      ${renderSettingsSection(
        {
          title: t("githubConnections.title"),
          description: t("githubConnections.description"),
          actions:
            this.canRead && (this.profileId || this.canAdmin)
              ? html`<button
                    class="btn btn--sm"
                    ?disabled=${this.locked || (!this.profileId && !this.system.status)}
                    @click=${() => this.openSetup(this.profileId ? "personal" : "system")}
                  >
                    ${t("agentTools.githubConnect")}
                  </button>
                  <button
                    class="btn btn--sm"
                    ?disabled=${this.locked}
                    @click=${() => {
                      void this.personal.verify();
                      void this.system.verify();
                    }}
                  >
                    ${t("agentTools.githubVerify")}
                  </button>`
              : undefined,
        },
        html`
          <div data-github-connection="personal">
            ${renderSettingsRow({
              title: t("githubConnections.mine"),
              description: this.profileId
                ? html`${personal?.account ? `@${personal.account.login} · ` : ""}${t(
                    "githubConnections.personalDescription",
                  )}`
                : t("githubConnections.unboundDescription"),
              control: html`${renderSettingsStatus({
                kind: reconnectRequired ? "warn" : connected ? "ok" : "muted",
                label: personalLabel,
              })}
              ${this.profileId && this.canRead
                ? html`<button
                    class="btn btn--sm"
                    ?disabled=${this.locked}
                    @click=${() => this.openSetup("personal")}
                  >
                    ${connected
                      ? t("githubConnections.changeMine")
                      : t("githubConnections.connectMine")}
                  </button>`
                : nothing}`,
            })}
          </div>
          <div data-github-connection="system">
            ${renderSettingsRow({
              title: t("githubConnections.system"),
              description: html`${system?.account ? `@${system.account.login} · ` : ""}${t(
                "githubConnections.systemDescription",
              )}`,
              control: html`${renderGitHubHealth(system)}${this.canAdmin
                ? html`<button
                    class="btn btn--sm"
                    ?disabled=${this.locked || !this.system.status}
                    @click=${() => this.openSetup("system")}
                  >
                    ${t("githubConnections.changeSystem")}
                  </button>`
                : renderSettingsValue(t("githubConnections.adminManaged"))}`,
            })}
          </div>
          ${this.personal.error || this.system.error
            ? renderSettingsRow({
                title: t("agentTools.githubErrorTitle"),
                description: html`<span role="alert"
                  >${this.personal.error ?? this.system.error}</span
                >`,
                control: html`<button
                  class="btn btn--sm"
                  ?disabled=${this.locked}
                  @click=${() => {
                    void this.personal.verify();
                    void this.system.verify();
                  }}
                >
                  ${t("common.retry")}
                </button>`,
              })
            : nothing}
          ${showSetup
            ? html`<div class="settings-subrows" data-github-setup>
                ${renderSettingsRow({
                  title: t("githubConnections.purpose"),
                  control:
                    this.profileId && this.canAdmin && this.system.status
                      ? renderSettingsSegmented({
                          value: this.purpose,
                          options: [
                            { value: "personal", label: t("githubConnections.forMe") },
                            { value: "system", label: t("githubConnections.forSystem") },
                          ],
                          disabled: this.locked,
                          ariaLabel: t("githubConnections.purpose"),
                          onChange: (purpose) => this.openSetup(purpose),
                        })
                      : renderSettingsValue(
                          this.purpose === "personal"
                            ? t("githubConnections.forMe")
                            : t("githubConnections.forSystem"),
                        ),
                })}
                ${renderGitHubConnectionSetup(active)}
                ${!this.locked
                  ? renderSettingsRow({
                      title: t("githubConnections.purposeHint"),
                      control: html`<button
                        class="btn btn--sm"
                        @click=${() => {
                          this.setupOpen = false;
                          active.hidePatFallback();
                        }}
                      >
                        ${t("common.close")}
                      </button>`,
                    })
                  : nothing}
              </div>`
            : nothing}
          <details class="settings-row settings-row--stacked">
            <summary class="settings-row__title">${t("githubConnections.usage")}</summary>
            <div class="settings-row__desc">${t("githubConnections.usageDescription")}</div>
            ${renderGitHubDetails(system)}
          </details>
          ${this.canAdmin && this.system.status?.selected.configured
            ? renderSettingsRow({
                title: t("agentTools.githubUseNativeNewRuns"),
                description: t("agentTools.githubSystemMutationHint"),
                control: html`<button
                  class="btn btn--sm"
                  ?disabled=${this.locked}
                  @click=${() => void this.system.inherit()}
                >
                  ${t("agentTools.githubUseNativeNewRuns")}
                </button>`,
              })
            : nothing}
        `,
      )}
      ${this.profileId && this.canRead && personal && personal.state !== "disconnected"
        ? renderSettingsSection(
            { danger: true },
            renderSettingsRow({
              title: t("githubConnections.disconnectMine"),
              description: t("githubConnections.disconnectDescription"),
              control: html`<button
                class="btn btn--sm"
                ?disabled=${this.locked}
                @click=${() => void this.personal.disconnect()}
              >
                ${t("githubConnections.disconnectMine")}
              </button>`,
            }),
          )
        : nothing}
    </div>`;
  }
}
if (!customElements.get("openclaw-github-connections")) {
  customElements.define("openclaw-github-connections", GitHubConnections);
}
