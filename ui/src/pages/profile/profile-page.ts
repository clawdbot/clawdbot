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
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser, userProfileAvatarUrl } from "../../app/user-profile.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsPage,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../../lib/avatar.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { buildSessionUsageDateParams, requestSessionsUsage } from "../../lib/sessions/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import {
  decideUsageRefresh,
  USAGE_PAYLOAD_TTL_MS,
  type UsageRefreshReason,
} from "../usage/refresh-policy.ts";
import "../../styles/profile.css";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import { renderIdentitySection } from "./identity-section.ts";
import {
  renderProfileHeatmap,
  renderProfileInsights,
  renderProfileStats,
} from "./profile-stat-sections.ts";
import { buildInsights, firstActiveDate, formatTokenScale, type ProfileInsights } from "./stats.ts";

function formatMonthYear(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function toErrorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("usage");
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" ? error : "request failed";
}

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

  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private costSummary: CostUsageSummary | null = null;
  @state() private sessionsResult: SessionsUsageResult | null = null;
  @state() private selfUser: AuthenticatedUser | null = null;
  @state() private ownProfile: UserProfile | null = null;
  @state() private displayName = "";
  @state() private identityLoading = false;
  @state() private identityBusy: "display-name" | "avatar" | null = null;
  @state() private identityError: string | null = null;

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private requestId = 0;
  private identityRequestId = 0;
  private refreshTimer: number | null = null;
  private lastProfileLoadedAtMs: number | null = null;
  private pendingAutomaticProfileRefresh = false;
  // Set only when a disconnect invalidates active work. The shared refresh
  // policy decides when the retry is allowed to run.
  private profileReloadPending = false;
  private subscriptions: Array<() => void> = [];

  private readonly handlePageActivation = () => {
    this.requestProfileRefresh("focus");
  };

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot)),
      this.context.agents.subscribe(() => this.requestUpdate()),
      this.context.agentIdentity.subscribe(() => this.requestUpdate()),
    ];
    document.addEventListener("visibilitychange", this.handlePageActivation);
    globalThis.addEventListener("focus", this.handlePageActivation);
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    document.removeEventListener("visibilitychange", this.handlePageActivation);
    globalThis.removeEventListener("focus", this.handlePageActivation);
    this.requestId += 1;
    this.identityRequestId += 1;
    this.clearRefreshTimer();
    this.pendingAutomaticProfileRefresh = false;
    this.profileReloadPending = false;
    this.client = null;
    this.connected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const becameConnected = snapshot.connected && !this.connected;
    const nextSelfUser = snapshot.connected
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : null;
    const selfProfileChanged = nextSelfUser?.id !== this.selfUser?.id;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    this.selfUser = nextSelfUser;
    if (clientChanged) {
      // Never keep one gateway's stats on screen while another gateway loads
      // (or fails to load); the render branches key off costSummary presence.
      this.clearRefreshTimer();
      this.requestId += 1;
      this.loading = false;
      this.lastProfileLoadedAtMs = null;
      this.pendingAutomaticProfileRefresh = false;
      this.profileReloadPending = false;
      this.costSummary = null;
      this.sessionsResult = null;
      this.error = null;
    }
    if (clientChanged || selfProfileChanged) {
      this.identityRequestId += 1;
      this.ownProfile = null;
      this.displayName = "";
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
    }
    if (!snapshot.connected || !snapshot.client) {
      this.profileReloadPending ||= this.loading;
      this.requestId += 1;
      this.clearRefreshTimer();
      this.loading = false;
      return;
    }
    if (nextSelfUser && (clientChanged || selfProfileChanged)) {
      void this.loadIdentity();
    }
    void this.context.agents.ensureList().then((list) => {
      if (list) {
        void this.context.agentIdentity.ensure([list.defaultId]);
      }
    });
    if (clientChanged || becameConnected || (!this.costSummary && !this.loading && !this.error)) {
      this.requestProfileRefresh("reconnect");
    }
  }

  private async loadProfile() {
    const client = this.client;
    if (!client || !this.connected) {
      this.profileReloadPending = true;
      return;
    }
    this.profileReloadPending = false;
    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    const dateParams = buildSessionUsageDateParams("local");
    try {
      const [costSummary, sessionsResult] = await Promise.all([
        // agentScope "all" keeps token stats consistent with the all-agent insights.
        client.request<CostUsageSummary>("usage.cost", {
          range: "all",
          agentScope: "all",
          ...dateParams,
        }),
        requestSessionsUsage(client, {
          range: "all",
          agentScope: "all",
          // Instance rows keep durations per transcript; family rollups would
          // merge resets and inflate "Longest thread" to the family lifespan.
          groupBy: "instance",
          limit: 1000,
          ...dateParams,
        }).catch(() => null),
      ]);
      if (requestId !== this.requestId) {
        return;
      }
      this.costSummary = costSummary;
      this.sessionsResult = sessionsResult;
      this.lastProfileLoadedAtMs = Date.now();
      this.scheduleCacheSettleRefresh();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = toErrorMessage(error);
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.flushPendingAutomaticProfileRefresh();
      }
    }
  }

  /**
   * usage.cost/sessions.usage answer immediately from the persisted cache and
   * rebuild in the background ("refreshing"/"partial"). Poll until the cache
   * settles so a cold start converges instead of freezing first-load numbers.
   */
  private isCacheSettling(): boolean {
    return [this.costSummary?.cacheStatus?.status, this.sessionsResult?.cacheStatus?.status].some(
      (status) => status === "refreshing" || status === "partial",
    );
  }

  private scheduleCacheSettleRefresh() {
    this.clearRefreshTimer();
    if (!this.isCacheSettling()) {
      return;
    }
    const loadedAtMs = this.lastProfileLoadedAtMs ?? Date.now();
    const ageMs = Math.max(0, Date.now() - loadedAtMs);
    const interval = Math.max(0, USAGE_PAYLOAD_TTL_MS - ageMs);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.requestProfileRefresh("poll");
    }, interval);
  }

  private clearRefreshTimer() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private requestProfileRefresh(reason: UsageRefreshReason) {
    if (this.loading && reason !== "manual") {
      this.pendingAutomaticProfileRefresh = true;
      return;
    }
    this.pendingAutomaticProfileRefresh = false;
    const decision = decideUsageRefresh({
      reason,
      visible: document.visibilityState === "visible" && document.hasFocus(),
      interrupted: this.profileReloadPending,
      nowMs: Date.now(),
      lastLoadedAtMs: this.lastProfileLoadedAtMs,
    });
    if (decision === "fetch") {
      this.clearRefreshTimer();
      void this.loadProfile();
    } else if (decision === "skip" && this.isCacheSettling()) {
      this.scheduleCacheSettleRefresh();
    }
  }

  private flushPendingAutomaticProfileRefresh() {
    if (!this.pendingAutomaticProfileRefresh) {
      return;
    }
    this.pendingAutomaticProfileRefresh = false;
    this.requestProfileRefresh("focus");
  }

  private async loadIdentity() {
    const client = this.client;
    if (!client || !this.connected) {
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
        result.profile.updatedAt,
      );
      if (avatarUrl) {
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
    const avatarUrl = userProfileAvatarUrl(
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
    this.requestProfileRefresh("manual");
    if (this.selfUser && !this.identityBusy) {
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
    if (avatarUrl) {
      return html`<img class="profile-hero__avatar-image" src=${avatarUrl} alt=${name} />`;
    }
    if (textAvatar) {
      return html`<span class="profile-hero__avatar-text">${textAvatar}</span>`;
    }
    return html`<span class="profile-hero__avatar-mascot" aria-hidden="true"
      >${icons.lobster}</span
    >`;
  }

  private renderHero(insights: ProfileInsights | null) {
    const { agentId, name, avatarUrl, textAvatar } = this.featuredAgent();
    const since = this.costSummary ? firstActiveDate(this.costSummary.daily) : null;
    const channels = insights?.topChannels ?? [];
    return renderSettingsGroup(html`
      <section class="profile-hero">
        <div class="profile-hero__avatar">${this.renderAvatar(avatarUrl, textAvatar, name)}</div>
        <div class="profile-hero__name">${name}</div>
        <div class="profile-hero__handle">
          <span>@${agentId}</span>
          <span class="profile-hero__badge">OpenClaw</span>
        </div>
        <div class="profile-hero__chips">
          ${since
            ? html`<span class="profile-hero__chip">
                ${t("profilePage.sinceChip", { date: formatMonthYear(since) })}
              </span>`
            : nothing}
          ${channels.map(
            (entry) => html`
              <span
                class="profile-hero__chip profile-hero__chip--channel"
                title=${t("profilePage.channelChipTitle", {
                  tokens: formatTokenScale(entry.tokens),
                })}
              >
                ${entry.channel}
              </span>
            `,
          )}
        </div>
      </section>
    `);
  }

  private renderBody() {
    if (!this.connected || !this.client) {
      return renderSettingsPage(renderSettingsGroup(renderSettingsEmpty(t("profilePage.offline"))));
    }
    const renderIdentityAwareState = (content: unknown) =>
      renderSettingsPage(this.selfUser ? html`${this.renderIdentity()} ${content}` : content);
    if (this.loading && !this.costSummary) {
      return renderIdentityAwareState(
        renderSettingsGroup(renderSettingsEmpty(t("profilePage.loading"))),
      );
    }
    if (this.error && !this.costSummary) {
      return renderIdentityAwareState(
        renderSettingsGroup(renderSettingsEmpty(this.error), { danger: true }),
      );
    }
    const insights = this.sessionsResult ? buildInsights(this.sessionsResult) : null;
    const hasActivity = (this.costSummary?.totals.totalTokens ?? 0) > 0;
    // A cold usage cache legitimately reports zero while it rebuilds; the
    // settle poll keeps retrying, so the loading note stays truthful until
    // real data or a genuinely fresh shell arrives.
    const emptyState = this.isCacheSettling()
      ? renderSettingsGroup(renderSettingsEmpty(t("profilePage.loading")))
      : renderSettingsGroup(
          renderSettingsEmpty(
            html`<strong>${t("profilePage.emptyTitle")}</strong><br />${t("profilePage.emptyBody")}`,
          ),
        );
    return renderSettingsPage(
      hasActivity
        ? html`${this.renderHero(insights)} ${renderProfileStats(this.costSummary, insights)}
          ${this.renderIdentity()} ${renderProfileHeatmap(this.costSummary)}
          ${renderProfileInsights(insights)}`
        : html`${this.renderHero(insights)} ${this.renderIdentity()} ${emptyState}`,
    );
  }

  override render() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("profile")}</div>
        </div>
        <button class="btn profile-refresh" @click=${() => this.refreshManually()}>
          ${this.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </section>
      ${renderSettingsWorkspace(this.renderBody())}
    `;
  }
}

if (!customElements.get("openclaw-profile-page")) {
  customElements.define("openclaw-profile-page", ProfilePage);
}
