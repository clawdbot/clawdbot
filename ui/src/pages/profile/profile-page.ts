import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UserProfile,
  UsersSelfResult,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser, userProfileAvatarUrl } from "../../app/user-profile.ts";
import { icons } from "../../components/icons.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { AuthenticatedAvatarRouteLoader } from "../../lib/authenticated-avatar-route.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import "../../styles/profile.css";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import { renderIdentitySection } from "./identity-section.ts";

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

function toIdentityErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" && error.trim()
    ? error
    : t("profilePage.identity.profileUnavailable");
}

export class ProfilePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private selfUser: AuthenticatedUser | null = null;
  @state() private ownProfile: UserProfile | null = null;
  @state() private displayName = "";
  @state() private identityLoading = false;
  @state() private identityBusy: "display-name" | "avatar" | null = null;
  @state() private identityError: string | null = null;
  @state() private failedHeroAvatarUrl: string | null = null;

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private heroAvatarAuthCandidates: string[] = [];
  private heroAvatarAuthReady = false;
  private readonly heroAvatarLoader = new AuthenticatedAvatarRouteLoader(() => {
    if (this.isConnected) {
      this.requestUpdate();
    }
  });
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
    this.heroAvatarLoader.reset();
    this.heroAvatarAuthCandidates = [];
    this.heroAvatarAuthReady = false;
    this.client = null;
    this.connected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    // The /api/users avatar route only accepts shared secrets; a single
    // device-token candidate would 401 forever. Offer the full ordered list.
    const nextHeroAvatarAuthCandidates = resolveControlUiAuthCandidates({
      hello: snapshot.hello,
      settings: { token: this.context.gateway.connection.token },
      password: this.context.gateway.connection.password,
    });
    if (
      nextHeroAvatarAuthCandidates.join("\u0000") !== this.heroAvatarAuthCandidates.join("\u0000")
    ) {
      this.heroAvatarAuthCandidates = nextHeroAvatarAuthCandidates;
    }
    this.heroAvatarAuthReady = Boolean(
      snapshot.hello ||
      this.context.gateway.connection.token.trim() ||
      this.context.gateway.connection.password.trim(),
    );
    const clientChanged = snapshot.client !== this.client;
    const nextConnected = snapshot.phase === "connected";
    const connectionChanged = nextConnected !== this.connected;
    const nextSelfUser = nextConnected
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : null;
    const selfProfileChanged = nextSelfUser?.id !== this.selfUser?.id;
    const identitySourceChanged = clientChanged || connectionChanged || selfProfileChanged;
    this.client = snapshot.client;
    this.connected = nextConnected;
    this.selfUser = nextSelfUser;
    // connected/client are plain fields; an unidentified (token-auth) connect or
    // disconnect changes no @state, so the render branch must be invalidated
    // explicitly or the page sticks on the stale offline/connected view.
    this.requestUpdate();
    if (identitySourceChanged) {
      this.identityRequestId += 1;
      this.ownProfile = null;
      this.displayName = "";
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
    }
    if (!nextConnected || !snapshot.client) {
      return;
    }
    if (nextSelfUser && identitySourceChanged) {
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
    if (!client || !this.connected || this.identityLoading) {
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
      const result = await client.request<Partial<UsersSelfResult> | null>("users.self", {});
      if (requestId !== this.identityRequestId) {
        return;
      }
      const profile = result?.profile;
      if (!profile) {
        return;
      }
      this.ownProfile = profile;
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
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

  private applyOwnProfile(profile: UserProfile) {
    this.ownProfile = profile;
    this.displayName = profile.displayName ?? "";
  }

  private async saveDisplayName() {
    const client = this.client;
    const profile = this.ownProfile;
    if (!client || !profile || this.identityBusy || this.identityLoading) {
      return;
    }
    this.identityBusy = "display-name";
    this.identityError = null;
    const identityRequestId = this.identityRequestId;
    let shouldRefresh = false;
    try {
      const displayName = this.displayName.trim() || null;
      const result = await client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
        profileId: profile.id,
        displayName,
      });
      if (client !== this.client || identityRequestId !== this.identityRequestId) {
        return;
      }
      this.applyOwnProfile(result.profile);
      this.context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
      shouldRefresh = true;
    } catch (error) {
      if (client === this.client && identityRequestId === this.identityRequestId) {
        this.identityError = toIdentityErrorMessage(error);
      }
    } finally {
      if (identityRequestId === this.identityRequestId && this.identityBusy === "display-name") {
        this.identityBusy = null;
      }
    }
    if (shouldRefresh && client === this.client && identityRequestId === this.identityRequestId) {
      void this.loadIdentity();
    }
  }

  private async saveAvatar(file: File) {
    const client = this.client;
    const profile = this.ownProfile;
    if (!client || !profile || this.identityBusy || this.identityLoading) {
      return;
    }
    this.identityBusy = "avatar";
    this.identityError = null;
    const identityRequestId = this.identityRequestId;
    const displayNameDraft = this.displayName;
    const hasUnsavedDisplayName = displayNameDraft.trim() !== (profile.displayName ?? "");
    const selfAvatarUrlBefore =
      this.selfUser?.id === profile.id ? this.selfUser.avatarUrl : undefined;
    let shouldRefresh = false;
    try {
      const avatar = await processProfileAvatar(file);
      if (client !== this.client || identityRequestId !== this.identityRequestId) {
        return;
      }
      const result = await client.request<UsersSetAvatarResult>("users.setAvatar", {
        profileId: profile.id,
        mime: avatar.mime,
        avatarBase64: avatar.avatarBase64,
      });
      if (client !== this.client || identityRequestId !== this.identityRequestId) {
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
      );
      const presenceAvatarChanged =
        this.selfUser?.id === result.profile.id && this.selfUser.avatarUrl !== selfAvatarUrlBefore;
      if (avatarUrl && !presenceAvatarChanged) {
        this.context.gateway.updateSelfUser?.({ avatarUrl });
      }
      shouldRefresh = true;
    } catch (error) {
      if (client === this.client && identityRequestId === this.identityRequestId) {
        this.identityError =
          error instanceof ProfileAvatarError
            ? t(
                error.code === "too-large"
                  ? "profilePage.identity.avatarErrors.tooLarge"
                  : error.code === "source-too-large"
                    ? "profilePage.identity.avatarErrors.sourceTooLarge"
                    : "profilePage.identity.avatarErrors.invalid",
              )
            : toIdentityErrorMessage(error);
      }
    } finally {
      if (identityRequestId === this.identityRequestId && this.identityBusy === "avatar") {
        this.identityBusy = null;
      }
    }
    if (shouldRefresh && client === this.client && identityRequestId === this.identityRequestId) {
      void this.loadIdentity();
    }
  }

  private renderIdentity() {
    if (!this.selfUser) {
      return nothing;
    }
    if (!this.ownProfile) {
      // users.self is the idempotent gateway-owned profile ensure path. Retrying
      // keeps profile ids and authenticated email linkage authoritative server-side.
      const emptyState = this.identityLoading
        ? t("profilePage.identity.loading")
        : this.identityError
          ? this.identityError
          : html`<div class="profile-identity-empty">
              <span>${t("profilePage.identity.notSet")}</span>
              <button type="button" class="btn btn--sm" @click=${() => void this.loadIdentity()}>
                ${t("profilePage.identity.setIdentity")}
              </button>
            </div>`;
      return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
        ${renderSettingsSection(
          { title: t("profilePage.identity.title") },
          renderSettingsEmpty(emptyState),
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
          );
    return renderIdentitySection({
      profile: this.ownProfile,
      avatarUrl,
      displayName: this.displayName,
      busy: this.identityLoading ? "loading" : this.identityBusy,
      error: this.identityError,
      onDisplayNameInput: (value) => {
        this.displayName = value;
      },
      onSaveDisplayName: () => void this.saveDisplayName(),
      onAvatarSelect: (file) => void this.saveAvatar(file),
    });
  }

  private refreshManually() {
    if (this.selfUser && !this.identityBusy && !this.identityLoading) {
      void this.loadIdentity();
    }
  }

  private featuredAgent() {
    const list = this.context.agents.state.agentsList;
    const agentId = list?.defaultId ?? "main";
    const row = list?.agents.find((agent) => agent.id === agentId) ?? { id: agentId };
    const identity = this.context.agentIdentity.get(agentId);
    const avatarUrl = resolveAgentAvatarUrl(row, identity);
    const textAvatar =
      resolveAssistantTextAvatar(identity?.avatar) ??
      resolveAssistantTextAvatar(row.identity?.emoji) ??
      resolveAssistantTextAvatar(row.identity?.avatar);
    const name =
      identity?.name?.trim() || row.identity?.name?.trim() || row.name?.trim() || agentId;
    return { agentId, name, avatarUrl, textAvatar };
  }

  private renderAvatar(avatarUrl: string | null, textAvatar: string | null, name: string) {
    const imageUrl = avatarUrl?.startsWith("/")
      ? this.heroAvatarAuthReady
        ? this.heroAvatarLoader.resolve(avatarUrl, this.heroAvatarAuthCandidates)
        : null
      : avatarUrl;
    if (avatarUrl && avatarUrl !== this.failedHeroAvatarUrl) {
      if (imageUrl) {
        return html`<img
          class="profile-hero__avatar-image"
          src=${imageUrl}
          alt=${name}
          @error=${() => {
            this.failedHeroAvatarUrl = avatarUrl;
          }}
        />`;
      }
    }
    if (textAvatar) {
      return html`<span class="profile-hero__avatar-text">${textAvatar}</span>`;
    }
    return html`<span class="profile-hero__avatar-mascot" aria-hidden="true"
      >${icons.lobster}</span
    >`;
  }

  private renderHero() {
    const { agentId, name, avatarUrl, textAvatar } = this.featuredAgent();
    return renderSettingsGroup(html`
      <section class="profile-hero">
        <div class="profile-hero__avatar">${this.renderAvatar(avatarUrl, textAvatar, name)}</div>
        <div class="profile-hero__name">${name}</div>
        <div class="profile-hero__handle">
          <span>@${agentId}</span>
          <span class="profile-hero__badge">OpenClaw</span>
        </div>
      </section>
    `);
  }

  private renderBody() {
    if (!this.connected || !this.client) {
      return renderSettingsPage(renderSettingsGroup(renderSettingsEmpty(t("profilePage.offline"))));
    }
    return renderSettingsPage(html`
      ${this.renderHero()} ${this.renderIdentity()}
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
            ${subtitleForRoute("profile")}
            ${renderDocsLink(PROFILE_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
        ${this.selfUser
          ? html`<button
              class="btn profile-refresh"
              ?disabled=${this.identityLoading || this.identityBusy !== null}
              @click=${() => this.refreshManually()}
            >
              ${this.identityLoading ? t("common.refreshing") : t("common.refresh")}
            </button>`
          : nothing}
      </section>
      ${renderSettingsWorkspace(this.renderBody())}
    `;
  }
}

if (!customElements.get("openclaw-profile-page")) {
  customElements.define("openclaw-profile-page", ProfilePage);
}
