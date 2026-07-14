import { consume } from "@lit/context";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  validateApprovalGetResult,
  validateApprovalResolveResult,
  type ApprovalDecision,
  type ApprovalGetResult,
  type ApprovalPresentation,
  type ApprovalResolveResult,
  type ApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import { i18n, t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_MIN_POLL_DELAY_MS = 250;

type ApprovalRequestError = "connection" | "unavailable" | null;
type ResolutionOrigin = "here" | "elsewhere" | "observed";

function isUnavailableApprovalError(error: unknown): boolean {
  if (!(error instanceof GatewayRequestError)) {
    return false;
  }
  const reason = isRecord(error.details) ? error.details.reason : undefined;
  return (
    reason === "APPROVAL_NOT_FOUND" ||
    error.gatewayCode === "APPROVAL_NOT_FOUND" ||
    error.gatewayCode === "INVALID_REQUEST"
  );
}

function formatApprovalTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

function decisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow-once":
      return t("execApproval.allowOnce");
    case "allow-always":
      return t("execApproval.alwaysAllow");
    case "deny":
      return t("execApproval.deny");
  }
  const unreachable: never = decision;
  return unreachable;
}

function appliedDecisionMatches(
  result: ApprovalResolveResult,
  decision: ApprovalDecision,
): boolean {
  if (!result.applied) {
    return true;
  }
  return decision === "deny"
    ? result.approval.status === "denied"
    : result.approval.status === "allowed" && result.approval.decision === decision;
}

function renderMetaRow(label: string, value?: string | null) {
  return value
    ? html`<div class="approval-page__meta-row">
        <dt>${label}</dt>
        <dd title=${value}><bdi dir="ltr">${value}</bdi></dd>
      </div>`
    : nothing;
}

function renderPresentation(presentation: ApprovalPresentation) {
  if (presentation.kind === "exec") {
    return html`
      ${presentation.warningText
        ? html`<div class="approval-page__warning" role="note">${presentation.warningText}</div>`
        : nothing}
      ${presentation.commandPreview
        ? html`
            <div class="approval-page__preview-label">${t("approvalPage.summaryLabel")}</div>
            <div class="approval-page__summary mono" dir="ltr">${presentation.commandPreview}</div>
          `
        : nothing}
      <div class="approval-page__preview-label">${t("approvalPage.commandLabel")}</div>
      <pre class="approval-page__preview mono" dir="ltr">${presentation.commandText}</pre>
      <dl class="approval-page__meta">
        ${renderMetaRow(t("execApproval.labels.host"), presentation.host)}
        ${renderMetaRow(t("approvalPage.nodeLabel"), presentation.nodeId)}
        ${renderMetaRow(t("execApproval.labels.agent"), presentation.agentId)}
      </dl>
    `;
  }
  const previewClass = "approval-page__preview approval-page__preview--prose";
  return html`
    <div class="approval-page__preview-label">${t("approvalPage.requestLabel")}</div>
    <div class=${previewClass}>${presentation.description}</div>
    <dl class="approval-page__meta">
      ${renderMetaRow(t("execApproval.labels.severity"), presentation.severity)}
      ${renderMetaRow(t("execApproval.labels.plugin"), presentation.pluginId)}
      ${renderMetaRow(t("approvalPage.toolLabel"), presentation.toolName)}
      ${renderMetaRow(t("execApproval.labels.agent"), presentation.agentId)}
    </dl>
  `;
}

function terminalTitle(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhere");
  }
  if (origin === "here" && approval.status === "allowed") {
    return t("approvalPage.approvedHere");
  }
  if (origin === "here" && approval.status === "denied") {
    return t("approvalPage.deniedHere");
  }
  const status = approval.status;
  switch (status) {
    case "allowed":
      return t("approvalPage.approved");
    case "denied":
      return t("approvalPage.denied");
    case "expired":
      return t("approvalPage.expired");
    case "cancelled":
      return t("approvalPage.cancelled");
    case "pending":
      return t("approvalPage.pending");
  }
  const unreachable: never = status;
  return unreachable;
}

function terminalDescription(approval: ApprovalSnapshot, origin: ResolutionOrigin): string {
  if (origin === "elsewhere" && (approval.status === "allowed" || approval.status === "denied")) {
    return t("approvalPage.resolvedElsewhereDescription");
  }
  const status = approval.status;
  switch (status) {
    case "allowed":
      return approval.decision === "allow-always"
        ? t("approvalPage.allowedAlwaysDescription")
        : t("approvalPage.allowedOnceDescription");
    case "denied":
      return t("approvalPage.deniedDescription");
    case "expired":
      return t("approvalPage.expiredDescription");
    case "cancelled":
      return t("approvalPage.cancelledDescription");
    case "pending":
      return t("approvalPage.pendingDescription");
  }
  const unreachable: never = status;
  return unreachable;
}

export class ApprovalPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  context!: ApplicationContext<RouteId>;

  @property({ attribute: "approval-id" }) approvalId = "";

  @state() private approval: ApprovalSnapshot | null = null;
  @state() private connected = false;
  @state() private loading = true;
  @state() private resolving = false;
  @state() private resolvingDecision: ApprovalDecision | null = null;
  @state() private requestError: ApprovalRequestError = null;
  @state() private resolutionOrigin: ResolutionOrigin = "observed";

  private client: GatewayBrowserClient | null = null;
  private operationGeneration = 0;
  private pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private stopGateway: (() => void) | undefined;
  private boundApprovalId: string | undefined;
  private previousDocumentTitle: string | undefined;
  private activeDocumentTitle: string | undefined;

  override connectedCallback() {
    // The host supplies a shellless loading fallback. Remove that unowned
    // light-DOM markup before Lit claims the root.
    this.replaceChildren();
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.previousDocumentTitle = document.title;
    this.bindApprovalId(true);
    this.stopGateway = this.context.gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(snapshot),
    );
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.invalidateOperations();
    this.clearPollTimer();
    this.client = null;
    this.connected = false;
    if (
      this.previousDocumentTitle !== undefined &&
      (!this.activeDocumentTitle || document.title === this.activeDocumentTitle)
    ) {
      document.title = this.previousDocumentTitle;
    }
    this.previousDocumentTitle = undefined;
    this.activeDocumentTitle = undefined;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("approvalId")) {
      this.bindApprovalId();
    }
    this.updateDocumentTitle();
  }

  private bindApprovalId(force = false) {
    if (!force && this.boundApprovalId === this.approvalId) {
      return;
    }
    this.boundApprovalId = this.approvalId;
    this.invalidateOperations();
    this.clearPollTimer();
    this.approval = null;
    this.loading = Boolean(this.approvalId);
    this.resolving = false;
    this.resolvingDecision = null;
    this.requestError = this.approvalId ? null : "unavailable";
    this.resolutionOrigin = "observed";
    if (this.approvalId && this.connected && this.client) {
      void this.loadApproval();
    }
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.connected;
    const becameConnected = snapshot.connected && !this.connected;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    if (clientChanged || connectionChanged) {
      this.invalidateOperations();
      this.clearPollTimer();
      this.resolving = false;
      this.resolvingDecision = null;
    }
    if (!snapshot.connected || !snapshot.client) {
      if (this.approvalId) {
        this.loading = false;
        this.requestError =
          !this.approval || this.approval.status === "pending" ? "connection" : null;
      }
      return;
    }
    if (!this.approvalId) {
      this.loading = false;
      this.requestError = "unavailable";
      return;
    }
    if (clientChanged || becameConnected || !this.approval) {
      void this.loadApproval();
      return;
    }
    this.schedulePoll();
  }

  private invalidateOperations() {
    this.operationGeneration += 1;
  }

  private isCurrentOperation(params: {
    client: GatewayBrowserClient;
    generation: number;
    id: string;
  }): boolean {
    return (
      this.hasGatewayConnection &&
      this.client === params.client &&
      this.approvalId === params.id &&
      this.operationGeneration === params.generation
    );
  }

  private get hasGatewayConnection(): boolean {
    return this.connected && Boolean(this.client);
  }

  private async loadApproval(options: { background?: boolean } = {}) {
    const client = this.client;
    const id = this.approvalId;
    if (!client || !this.connected || !id) {
      return;
    }
    const generation = ++this.operationGeneration;
    const previousStatus = this.approval?.status;
    let shouldFocusTerminal = false;
    this.clearPollTimer();
    if (!options.background) {
      this.loading = true;
    }
    try {
      const result = await client.request<ApprovalGetResult>("approval.get", { id });
      if (!this.isCurrentOperation({ client, generation, id })) {
        return;
      }
      if (!validateApprovalGetResult(result) || result.approval.id !== id) {
        this.approval = null;
        this.requestError = "unavailable";
        return;
      }
      this.requestError = null;
      this.approval = result.approval;
      if (result.approval.status === "pending") {
        this.resolutionOrigin = "observed";
      } else if (previousStatus === "pending" && this.resolutionOrigin === "observed") {
        this.resolutionOrigin = "elsewhere";
        shouldFocusTerminal = true;
      }
    } catch (error) {
      if (!this.isCurrentOperation({ client, generation, id })) {
        return;
      }
      if (isUnavailableApprovalError(error)) {
        this.approval = null;
        this.requestError = "unavailable";
      } else {
        this.requestError = "connection";
      }
    } finally {
      if (this.isCurrentOperation({ client, generation, id })) {
        this.loading = false;
        this.schedulePoll();
      }
    }
    if (shouldFocusTerminal && this.isCurrentOperation({ client, generation, id })) {
      await this.focusTerminalState();
    }
  }

  private async resolveApproval(decision: ApprovalDecision) {
    const approval = this.approval;
    const client = this.client;
    const id = this.approvalId;
    if (
      !client ||
      !this.connected ||
      !id ||
      approval?.status !== "pending" ||
      !approval.presentation.allowedDecisions.includes(decision) ||
      this.resolving
    ) {
      return;
    }
    const kind = approval.presentation.kind;
    const generation = ++this.operationGeneration;
    let shouldFocusTerminal = false;
    let shouldRecoverCanonicalState = false;
    this.clearPollTimer();
    this.resolving = true;
    this.resolvingDecision = decision;
    this.requestError = null;
    try {
      const result = await client.request<ApprovalResolveResult>("approval.resolve", {
        id,
        kind,
        decision,
      });
      if (!this.isCurrentOperation({ client, generation, id })) {
        return;
      }
      if (
        !validateApprovalResolveResult(result) ||
        result.approval.id !== id ||
        result.approval.presentation.kind !== kind ||
        !appliedDecisionMatches(result, decision)
      ) {
        // The write outcome is unknown. Keep every decision disabled until a
        // fresh, strictly validated read establishes canonical Gateway truth.
        this.requestError = "connection";
        shouldRecoverCanonicalState = true;
      } else {
        this.approval = result.approval;
        this.resolutionOrigin = result.applied ? "here" : "elsewhere";
        shouldFocusTerminal = true;
      }
    } catch (error) {
      if (!this.isCurrentOperation({ client, generation, id })) {
        return;
      }
      this.requestError = isUnavailableApprovalError(error) ? "unavailable" : "connection";
    } finally {
      if (this.isCurrentOperation({ client, generation, id })) {
        this.resolving = false;
        this.resolvingDecision = null;
        this.schedulePoll();
      }
    }
    if (shouldRecoverCanonicalState && this.isCurrentOperation({ client, generation, id })) {
      await this.loadApproval({ background: true });
      return;
    }
    if (shouldFocusTerminal && this.isCurrentOperation({ client, generation, id })) {
      await this.focusTerminalState();
    }
  }

  private async focusTerminalState() {
    await this.updateComplete;
    if (this.approval?.status === "pending") {
      return;
    }
    const heading = this.querySelector<HTMLElement>("#approval-page-title");
    heading?.focus({ preventScroll: true });
    if (typeof heading?.scrollIntoView === "function") {
      heading.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    }
  }

  private clearPollTimer() {
    if (this.pollTimer !== undefined) {
      globalThis.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePoll() {
    this.clearPollTimer();
    const approval = this.approval;
    if (
      !this.hasGatewayConnection ||
      this.resolving ||
      this.requestError === "unavailable" ||
      approval?.status !== "pending" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const untilDeadline = approval.expiresAtMs - Date.now();
    const delay = Math.max(
      APPROVAL_MIN_POLL_DELAY_MS,
      Math.min(APPROVAL_POLL_INTERVAL_MS, untilDeadline + APPROVAL_MIN_POLL_DELAY_MS),
    );
    this.pollTimer = globalThis.setTimeout(() => {
      this.pollTimer = undefined;
      void this.loadApproval({ background: true });
    }, delay);
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      this.clearPollTimer();
      return;
    }
    if (this.approval?.status === "pending" && this.hasGatewayConnection && !this.resolving) {
      void this.loadApproval({ background: true });
    }
  };

  private renderHeader() {
    return html`
      <header class="approval-page__brand">
        <img
          class="approval-page__logo"
          src=${controlUiPublicAssetPath("apple-touch-icon.png", this.context.basePath)}
          alt=""
        />
        <div>
          <div class="approval-page__eyebrow">${t("approvalPage.eyebrow")}</div>
          <div class="approval-page__brand-name">${t("approvalPage.brandName")}</div>
        </div>
      </header>
    `;
  }

  private renderLoading() {
    return html`
      <div class="approval-page__state approval-page__state--loading" role="status">
        <div class="approval-page__spinner" aria-hidden="true"></div>
        <h1 id="approval-page-title">${t("approvalPage.loadingTitle")}</h1>
        <p>${t("approvalPage.loadingDescription")}</p>
      </div>
    `;
  }

  private renderUnavailable() {
    return html`
      <div class="approval-page__state approval-page__state--unavailable" role="alert">
        <div class="approval-page__state-mark" aria-hidden="true">!</div>
        <h1 id="approval-page-title">${t("approvalPage.unavailableTitle")}</h1>
        <p>${t("approvalPage.unavailableDescription")}</p>
      </div>
    `;
  }

  private renderConnectionState() {
    return html`
      <div class="approval-page__state approval-page__state--connection" role="alert">
        <div class="approval-page__state-mark" aria-hidden="true">!</div>
        <h1 id="approval-page-title">${t("approvalPage.connectionErrorTitle")}</h1>
        <p>${t("approvalPage.connectionErrorDescription")}</p>
        <button
          type="button"
          class="btn"
          ?disabled=${!this.hasGatewayConnection || this.loading}
          @click=${() => void this.loadApproval()}
        >
          ${t("approvalPage.retry")}
        </button>
      </div>
    `;
  }

  private renderConnectionError() {
    return html`
      <div class="approval-page__callout" role="alert">
        <div>
          <strong>${t("approvalPage.connectionErrorTitle")}</strong>
          <span>${t("approvalPage.connectionErrorDescription")}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${!this.hasGatewayConnection || this.loading}
          @click=${() => void this.loadApproval()}
        >
          ${t("approvalPage.retry")}
        </button>
      </div>
    `;
  }

  private renderApproval(approval: ApprovalSnapshot) {
    const pending = approval.status === "pending";
    const presentation = approval.presentation;
    const title = pending
      ? presentation.kind === "plugin"
        ? presentation.title
        : t("approvalPage.execTitle")
      : terminalTitle(approval, this.resolutionOrigin);
    const statusDescription = pending
      ? t("approvalPage.pendingDescription")
      : terminalDescription(approval, this.resolutionOrigin);
    return html`
      <div class="approval-page__status" aria-live="polite" aria-atomic="true">
        <span
          class="approval-page__status-dot approval-page__status-dot--${approval.status}"
          aria-hidden="true"
        ></span>
        ${pending ? t("approvalPage.pending") : terminalTitle(approval, this.resolutionOrigin)}
      </div>
      <div class="approval-page__heading">
        <h1 id="approval-page-title" tabindex=${pending ? nothing : -1}>${title}</h1>
        <p>${statusDescription}</p>
      </div>
      ${renderPresentation(presentation)}
      <div class="approval-page__timing">
        <span>${pending ? t("approvalPage.expiresLabel") : t("approvalPage.resolvedLabel")}</span>
        <time
          datetime=${new Date(pending ? approval.expiresAtMs : approval.resolvedAtMs).toISOString()}
        >
          ${formatApprovalTime(pending ? approval.expiresAtMs : approval.resolvedAtMs)}
        </time>
      </div>
      ${this.requestError === "connection" ? this.renderConnectionError() : nothing}
      ${pending
        ? html`
            <div
              class="approval-page__actions"
              role="group"
              aria-label=${t("approvalPage.actionsLabel")}
            >
              ${presentation.allowedDecisions.map(
                (decision) => html`
                  <button
                    type="button"
                    class="btn approval-page__action approval-page__action--${decision}"
                    data-decision=${decision}
                    ?disabled=${this.resolving ||
                    !this.hasGatewayConnection ||
                    this.requestError !== null}
                    @click=${() => void this.resolveApproval(decision)}
                  >
                    ${this.resolvingDecision === decision
                      ? t("approvalPage.resolvingDecision", { decision: decisionLabel(decision) })
                      : decisionLabel(decision)}
                  </button>
                `,
              )}
            </div>
          `
        : html`
            <div class="approval-page__terminal" role="status">
              ${t("approvalPage.safeToClose")}
            </div>
          `}
    `;
  }

  override render() {
    const unavailable = this.requestError === "unavailable";
    const disconnected = this.requestError === "connection" && !this.approval;
    const documentState = unavailable
      ? "unavailable"
      : disconnected
        ? "connection-error"
        : (this.approval?.status ?? "loading");
    return html`
      <main class="approval-page" data-state=${documentState}>
        <div class="approval-page__backdrop" aria-hidden="true"></div>
        <section
          class="approval-page__card"
          aria-labelledby="approval-page-title"
          aria-busy=${this.loading || this.resolving ? "true" : "false"}
        >
          ${this.renderHeader()}
          <div class="approval-page__content">
            ${this.loading && !this.approval
              ? this.renderLoading()
              : disconnected
                ? this.renderConnectionState()
                : unavailable || !this.approval
                  ? this.renderUnavailable()
                  : this.renderApproval(this.approval)}
          </div>
        </section>
        <a class="approval-page__back-link" href=${`${this.context.basePath}/chat`}>
          ${t("approvalPage.openControlUi")}
        </a>
      </main>
    `;
  }

  private updateDocumentTitle() {
    const pageTitle =
      this.requestError === "unavailable"
        ? t("approvalPage.unavailableTitle")
        : this.requestError === "connection" && !this.approval
          ? t("approvalPage.connectionErrorTitle")
          : this.approval
            ? this.approval.status === "pending"
              ? this.approval.presentation.kind === "plugin"
                ? this.approval.presentation.title
                : t("approvalPage.execTitle")
              : terminalTitle(this.approval, this.resolutionOrigin)
            : t("approvalPage.loadingTitle");
    const title = `${pageTitle} — ${t("approvalPage.brandName")}`;
    document.title = title;
    this.activeDocumentTitle = title;
  }
}
