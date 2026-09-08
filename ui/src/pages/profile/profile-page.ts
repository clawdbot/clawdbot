import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UserProfile,
  UsersPrefsGetResult,
  UsersPrefsSetResult,
  UsersSelfResult,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser } from "../../app/user-profile.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import "../../styles/profile.css";
import "../../features/github-connections/github-connections.ts";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import "./model-accounts.ts";
import { renderIdentitySection } from "./identity-section.ts";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import { renderProfileHero } from "./profile-hero.ts";

registerModelAccountsEnglish();

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

type IdentityChange =
  | { kind: "display-name" }
  | { kind: "avatar"; file: File }
  | { kind: "git-coauthor"; enabled: boolean };

function toIdentityErrorMessage(error: unknown): string {
  return formatUiError(error, t("profilePage.identity.profileUnavailable"));
}

export class ProfilePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private selfUser: AuthenticatedUser | null = null;
  @state() private ownProfile: UserProfile | null = null;
  @state() private displayName = "";
  @state() private gitCoauthorEnabled = true;
  @state() private identityLoading = false;
  @state() private identityBusy: IdentityChange["kind"] | null = null;
  @state() private identityError: string | null = null;
  @state() private failedHeroAvatarUrl: string | null = null;

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private canWrite = false;
  private readonly heroAvatarLoader = new IdentityAvatarController(this);
  private identityRequestId = 0;
  private subscriptions: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot)),
      this.context.agents.subscribe(() => this.requestUpdate()),
      this.context.agentIdentity.subscribe(() => this.requestUpdate()),
    ];
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.identityRequestId += 1;
    this.client = null;
    this.connected = false;
    this.canWrite = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const nextConnected = snapshot.phase === "connected";
    const nextCanWrite = nextConnected && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const writeAccessChanged = nextCanWrite !== this.canWrite;
    const connectionChanged = nextConnected !== this.connected;
    const nextSelfUser = nextConnected
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : null;
    const selfProfileChanged = nextSelfUser?.id !== this.selfUser?.id;
    const identitySourceChanged =
      clientChanged || connectionChanged || selfProfileChanged || writeAccessChanged;
    this.client = snapshot.client;
    this.connected = nextConnected;
    this.canWrite = nextCanWrite;
    this.selfUser = nextSelfUser;
    // connected/client are plain fields; an unidentified connect or
    // disconnect changes no @state, so the render branch must be invalidated
    // explicitly or the page sticks on the stale offline/connected view.
    this.requestUpdate();
    if (identitySourceChanged) {
      this.identityRequestId += 1;
      this.ownProfile = null;
      this.displayName = "";
      this.gitCoauthorEnabled = true;
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
    }
    if (!nextConnected || !snapshot.client) {
      return;
    }
    if (nextSelfUser && nextCanWrite && identitySourceChanged) {
      void this.loadIdentity();
    }
    void this.context.agents.ensureList().then((list) => {
      if (list) {
        void this.context.agentIdentity.ensure([list.defaultId]);
      }
    });
  }

  private async loadIdentity() {
    const client = this.client;
    // One active request owns the generation; reconnects clear loading before
    // starting their replacement so stale responses cannot win out of order.
    if (!client || !this.connected || !this.canWrite || this.identityLoading) {
      return;
    }
    const requestId = ++this.identityRequestId;
    const currentProfile = this.ownProfile;
    const displayNameDraft = this.displayName;
    const hasUnsavedDisplayName =
      currentProfile !== null && displayNameDraft.trim() !== (currentProfile.displayName ?? "");
    this.identityLoading = true;
    this.identityError = null;
    try {
      const result = await client.request<UsersSelfResult>("users.self", {});
      if (requestId !== this.identityRequestId) {
        return;
      }
      const profile = result.profile;
      this.ownProfile = profile;
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
      this.gitCoauthorEnabled = true;
      if (profile.githubIdentity) {
        const preferences = await client.request<UsersPrefsGetResult>("users.prefs.get", {
          keys: [GIT_COAUTHOR_PREFERENCE_KEY],
        });
        if (requestId !== this.identityRequestId) {
          return;
        }
        this.gitCoauthorEnabled =
          preferences.status === "ok" &&
          isGitCoauthorCreditEnabled(preferences.entries[GIT_COAUTHOR_PREFERENCE_KEY]);
      }
    } catch (error) {
      if (requestId === this.identityRequestId) {
        this.identityError = toIdentityErrorMessage(error);
      }
    } finally {
      if (requestId === this.identityRequestId) {
        this.identityLoading = false;
      }
    }
  }

  private async saveIdentity(change: IdentityChange) {
    const client = this.client;
    const profile = this.ownProfile;
    if (
      !client ||
      !profile ||
      !this.canWrite ||
      this.identityBusy ||
      this.identityLoading ||
      (change.kind === "git-coauthor" && !profile.githubIdentity)
    ) {
      return;
    }
    this.identityBusy = change.kind;
    this.identityError = null;
    const identityRequestId = this.identityRequestId;
    const isCurrent = () => client === this.client && identityRequestId === this.identityRequestId;
    try {
      switch (change.kind) {
        case "display-name": {
          const result = await client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
            profileId: profile.id,
            displayName: this.displayName.trim() || null,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = result.profile.displayName ?? "";
          this.context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
          break;
        }
        case "avatar": {
          const displayNameDraft = this.displayName;
          const hasUnsavedDisplayName = displayNameDraft.trim() !== (profile.displayName ?? "");
          const selfAvatarUrlBefore =
            this.selfUser?.id === profile.id ? this.selfUser.avatarUrl : undefined;
          const avatar = await processProfileAvatar(change.file);
          if (!isCurrent()) {
            return;
          }
          const result = await client.request<UsersSetAvatarResult>("users.setAvatar", {
            profileId: profile.id,
            mime: avatar.mime,
            avatarBase64: avatar.avatarBase64,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = hasUnsavedDisplayName
            ? displayNameDraft
            : (result.profile.displayName ?? "");
          const avatarUrl = userProfileAvatarUrl(
            this.context.gateway.connection.gatewayUrl,
            result.profile.id,
            result.avatarRevision,
            this.context.resourceBasePath,
          );
          const presenceAvatarChanged =
            this.selfUser?.id === result.profile.id &&
            this.selfUser.avatarUrl !== selfAvatarUrlBefore;
          if (avatarUrl && !presenceAvatarChanged) {
            this.context.gateway.updateSelfUser?.({ avatarUrl });
          }
          break;
        }
        case "git-coauthor": {
          const result = await client.request<UsersPrefsSetResult>("users.prefs.set", {
            entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: change.enabled },
          });
          if (!isCurrent()) {
            return;
          }
          if (result.status !== "ok") {
            throw new Error(t("profilePage.identity.profileUnavailable"));
          }
          this.gitCoauthorEnabled = change.enabled;
          return;
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.identityError =
          change.kind === "avatar" && error instanceof ProfileAvatarError
            ? t(
                error.code === "too-large"
                  ? "profilePage.identity.avatarErrors.tooLarge"
                  : error.code === "source-too-large"
                    ? "profilePage.identity.avatarErrors.sourceTooLarge"
                    : "profilePage.identity.avatarErrors.invalid",
              )
            : toIdentityErrorMessage(error);
      }
      return;
    } finally {
      if (isCurrent() && this.identityBusy === change.kind) {
        this.identityBusy = null;
      }
    }
    if (isCurrent()) {
      void this.loadIdentity();
    }
  }

  private renderIdentity() {
    if (!this.selfUser) {
      return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
        ${renderSettingsSection(
          { title: t("profilePage.identity.title") },
          renderSettingsEmpty(t("profilePage.identity.unidentified")),
        )}
      </div>`;
    }
    if (!this.canWrite) {
      return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
        ${renderSettingsSection(
          { title: t("profilePage.identity.title") },
          renderSettingsEmpty(t("profilePage.identity.writeRequired")),
        )}
      </div>`;
    }
    if (!this.ownProfile) {
      return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
        ${renderSettingsSection(
          { title: t("profilePage.identity.title") },
          this.identityLoading
            ? renderSettingsLoadingSkeleton({ label: t("profilePage.identity.loading"), rows: 2 })
            : renderSettingsEmpty(
                this.identityError ?? t("profilePage.identity.profileUnavailable"),
              ),
        )}
      </div>`;
    }
    // The gateway route serves an uploaded avatar first and its private Gravatar
    // fallback second, while a 404 still leaves the viewer-avatar initials visible.
    const avatarUrl =
      this.selfUser?.id === this.ownProfile.id && this.selfUser.avatarUrl
        ? this.selfUser.avatarUrl
        : userProfileAvatarUrl(
            this.context.gateway.connection.gatewayUrl,
            this.ownProfile.id,
            this.ownProfile.updatedAt,
            this.context.resourceBasePath,
          );
    return renderIdentitySection({
      profile: this.ownProfile,
      avatarUrl,
      displayName: this.displayName,
      gitCoauthorEnabled: this.gitCoauthorEnabled,
      busy: this.identityLoading ? "loading" : this.identityBusy,
      error: this.identityError,
      onDisplayNameInput: (value) => {
        this.displayName = value;
      },
      onSaveDisplayName: () => void this.saveIdentity({ kind: "display-name" }),
      onAvatarSelect: (file) => void this.saveIdentity({ kind: "avatar", file }),
      onGitCoauthorChange: (enabled) => void this.saveIdentity({ kind: "git-coauthor", enabled }),
    });
  }

  private renderModelAccounts() {
    return html`<openclaw-model-accounts
      .identityId=${this.selfUser?.id ?? null}
      .profileId=${this.ownProfile?.id ?? null}
      .personLabel=${
        this.ownProfile
          ? this.ownProfile.displayName?.trim() ||
            this.ownProfile.emails[0] ||
            t("profilePage.modelAccounts.currentPerson")
          : null
      }
    ></openclaw-model-accounts>`;
  }

  private refreshManually() {
    if (this.selfUser && this.canWrite && !this.identityBusy && !this.identityLoading) {
      void this.loadIdentity();
    }
  }

  private renderHero() {
    const list = this.context.agents.state.agentsList;
    const agentId = list?.defaultId ?? "main";
    const row = list?.agents.find((agent) => agent.id === agentId) ?? { id: agentId };
    return renderProfileHero({
      row,
      user: this.selfUser,
      identity: this.context.agentIdentity.get(agentId),
      resolveImageUrl: (avatarUrl) => this.heroAvatarLoader.resolve(avatarUrl),
      failedAvatarUrl: this.failedHeroAvatarUrl,
      onAvatarError: (avatarUrl) => {
        this.failedHeroAvatarUrl = avatarUrl;
      },
    });
  }

  private renderBody() {
    if (!this.connected || !this.client) {
      return renderSettingsPage(renderSettingsGroup(renderSettingsEmpty(t("profilePage.offline"))));
    }
    return renderSettingsPage(html`
      ${this.renderHero()} ${this.renderIdentity()} ${this.renderModelAccounts()}
      <openclaw-github-connections></openclaw-github-connections>
      ${renderSettingsGroup(
        renderSettingsNavRow({
          title: t("profilePage.usageStatistics"),
          description: t("profilePage.usageStatisticsDescription"),
          onClick: () => this.context.navigate("usage"),
        }),
      )}
    `);
  }

  override render() {
    return this.heroAvatarLoader.withActiveRoutes(() => this.renderContent());
  }

  private renderContent() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("profile")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("profile")} ${renderLearnMoreLink(PROFILE_DOCS_URL)}
          </div>
        </div>
        ${
          this.selfUser
            ? html`<button
                class="btn profile-refresh"
                ?disabled=${this.identityLoading || this.identityBusy !== null}
                @click=${() => this.refreshManually()}
              >
                ${this.identityLoading ? t("common.refreshing") : t("common.refresh")}
              </button>`
            : nothing
        }
      </section>
      ${renderSettingsWorkspace(this.renderBody())}
    `;
  }
}

if (!customElements.get("openclaw-profile-page")) {
  customElements.define("openclaw-profile-page", ProfilePage);
}
