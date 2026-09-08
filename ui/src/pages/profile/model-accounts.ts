import { consume } from "@lit/context";
import { nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { renderModelAccountsSection } from "./model-accounts-section.ts";

registerModelAccountsEnglish();

type AccountTarget = {
  client: GatewayBrowserClient;
  identityId: string;
  profileId: string;
  canAdmin: boolean;
};
type AccountAction = "request" | "answer" | "cancel";
type SignInChoice = {
  providers: UsersAuthConnectCatalogResult["providers"];
  provider: string;
  method: string;
};

/** Model-account actions belong to the connection, not the profile editor's refresh cycle. */
export class ModelAccounts extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @property({ attribute: false }) identityId: string | null = null;
  @property({ attribute: false }) profileId: string | null = null;
  @property({ attribute: false }) personLabel: string | null = null;
  @state() private links: UserProfileAuthLink[] = [];
  @state() private accounts: UserModelAccount[] = [];
  @state() private nextCursor: string | undefined;
  @state() private inventoryLoading = false;
  @state() private inventoryError: string | null = null;
  @state() private action: AccountAction | null = null;
  @state() private error: string | null = null;
  @state() private notice: "connected" | "cancelled" | "expired" | "selected" | "cleared" | null =
    null;
  @state() private linkDraft = "";
  @state() private signIn: SignInChoice | null = null;
  @state() private connectFlow: (UsersAuthConnectStartResult & { step?: WizardStep }) | null = null;
  @state() private stepValue: unknown;
  @state() private statusUnavailable = false;

  private target: AccountTarget | null = null;
  private generation = 0;
  private inventoryRequest = 0;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = this.context.gateway.subscribe((snapshot) => {
      this.applySnapshot(snapshot);
      // Endpoint and person context stay visible even without an authorized account target.
      this.requestUpdate();
    });
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.generation += 1;
    this.target = null;
    this.stopPoll();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if ((changed.has("profileId") || changed.has("identityId")) && this.isConnected) {
      this.applySnapshot(this.context.gateway.snapshot);
    }
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const canWrite =
      snapshot.phase === "connected" && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const client = canWrite ? snapshot.client : null;
    const identityId = snapshot.selfUser?.id ?? null;
    // users.self returns canonical IDs while presence may still name a merged alias.
    // Bind the parent's canonical result to its exact authenticated connection identity.
    const profileId = client && identityId === this.identityId ? this.profileId : null;
    const canAdmin = canWrite && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (
      this.target?.client === client &&
      this.target?.identityId === identityId &&
      this.target?.profileId === profileId &&
      this.target?.canAdmin === canAdmin
    ) {
      return;
    }
    this.generation += 1;
    this.stopPoll();
    this.target =
      client && identityId && profileId ? { client, identityId, profileId, canAdmin } : null;
    this.links = [];
    this.accounts = [];
    this.nextCursor = undefined;
    this.inventoryRequest += 1;
    this.inventoryLoading = false;
    this.inventoryError = null;
    this.action = null;
    this.error = null;
    this.notice = null;
    this.linkDraft = "";
    this.signIn = null;
    this.connectFlow = null;
    this.stepValue = undefined;
    this.statusUnavailable = false;
    if (this.target) {
      void this.loadAccounts();
    }
  }

  private applyLinks(links: UserProfileAuthLink[]) {
    this.links = links;
    this.accounts = this.accounts.map((account) => ({
      ...account,
      selected: links.some((link) => link.authProfileId === account.authProfileId),
    }));
  }

  private async loadAccounts(cursor?: string) {
    const target = this.target;
    if (!target) {
      return;
    }
    const request = ++this.inventoryRequest;
    const isCurrent = () =>
      this.isConnected && this.target === target && request === this.inventoryRequest;
    this.inventoryLoading = true;
    this.inventoryError = null;
    try {
      const result = await target.client.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        { profileId: target.profileId, ...(cursor ? { cursor } : {}) },
      );
      if (isCurrent()) {
        this.accounts = cursor ? [...this.accounts, ...result.accounts] : result.accounts;
        this.nextCursor = result.nextCursor;
        this.applyLinks(result.links);
      }
    } catch (error) {
      if (isCurrent()) {
        this.inventoryError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.inventoryLoading = false;
      }
    }
  }

  private isCurrent(target: AccountTarget, generation: number) {
    return this.isConnected && this.target === target && this.generation === generation;
  }

  private async runAction<T>(
    action: AccountAction,
    request: (target: AccountTarget) => Promise<T>,
    apply: (result: T) => void,
  ) {
    const target = this.target;
    if (!target || (this.action && !(action === "cancel" && this.action === "answer"))) {
      return;
    }
    const generation = ++this.generation;
    this.stopPoll();
    this.action = action;
    this.error = null;
    this.notice = null;
    this.statusUnavailable = false;
    try {
      const result = await request(target);
      if (this.isCurrent(target, generation)) {
        apply(result);
      }
    } catch (error) {
      if (this.isCurrent(target, generation)) {
        this.error = formatUiError(error, t("profilePage.modelAccounts.actionFailed"));
      }
    } finally {
      if (this.isCurrent(target, generation)) {
        this.action = null;
        this.schedulePoll(this.connectFlow?.step ? 2000 : 0);
      }
    }
  }

  private updateLink(change: { authProfileId: string } | { provider: string }) {
    const linking = "authProfileId" in change;
    if (linking && (!change.authProfileId || !this.target?.canAdmin)) {
      return;
    }
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersListAuthLinksResult>(
          linking ? "users.linkAuthProfile" : "users.unlinkAuthProfile",
          { profileId: target.profileId, ...change },
        ),
      (result) => {
        this.applyLinks(result.links);
        this.linkDraft = "";
        this.notice = linking ? "selected" : "cleared";
        void this.loadAccounts();
      },
    );
  }

  private selectAccount(authProfileId: string) {
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersSelectModelAccountResult>("users.selectModelAccount", {
          profileId: target.profileId,
          authProfileId,
        }),
      (result) => {
        this.applyLinks(result.links);
        this.notice = "selected";
        void this.loadAccounts();
      },
    );
  }

  private openSignIn() {
    this.signIn = { providers: [], provider: "", method: "" };
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersAuthConnectCatalogResult>("users.authConnect.catalog", {
          profileId: target.profileId,
        }),
      (result) => {
        this.signIn = { providers: result.providers, provider: "", method: "" };
      },
    );
  }

  private selectProvider(provider: string) {
    const choice = this.signIn;
    const entry = choice?.providers.find((candidate) => candidate.id === provider);
    if (choice && entry && !this.action && !this.connectFlow) {
      this.signIn = {
        ...choice,
        provider,
        method: entry.methods.length === 1 ? (entry.methods[0]?.id ?? "") : "",
      };
    }
  }

  private startConnect() {
    const choice = this.signIn;
    if (
      !choice?.providers.some(
        (provider) =>
          provider.id === choice.provider &&
          provider.methods.some((method) => method.id === choice.method),
      )
    ) {
      return;
    }
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersAuthConnectStartResult>("users.authConnect.start", {
          profileId: target.profileId,
          provider: choice.provider,
          method: choice.method,
        }),
      (result) => {
        this.connectFlow = result;
        this.stepValue = undefined;
      },
    );
  }

  private applyConnectStatus(result: UsersAuthConnectStatusResult) {
    if (result.status === "pending") {
      if (result.error) {
        this.error = formatUiError(result.error);
      }
      if (this.connectFlow) {
        if (this.connectFlow.step?.id !== result.step?.id) {
          this.stepValue = result.step?.sensitive ? undefined : result.step?.initialValue;
        }
        this.connectFlow = { ...this.connectFlow, step: result.step };
      }
      return;
    }
    this.error = null;
    this.statusUnavailable = false;
    this.stopPoll();
    this.signIn = null;
    this.connectFlow = null;
    this.stepValue = undefined;
    if (result.status === "failed") {
      this.error = t(`profilePage.modelAccounts.connectErrors.${result.reason}`);
      return;
    }
    if (result.status === "connected") {
      this.applyLinks(result.links);
      void this.loadAccounts();
    }
    this.notice = result.status;
  }

  private connectStatus(action: "cancel" | "status") {
    const flow = this.connectFlow;
    if (!flow) {
      return;
    }
    void this.runAction(
      action === "status" ? "request" : action,
      (target) =>
        target.client.request<UsersAuthConnectStatusResult>(`users.authConnect.${action}`, {
          profileId: target.profileId,
          connectId: flow.connectId,
        }),
      (result) => this.applyConnectStatus(result),
    );
  }

  private answerStep(stepId: string, value: unknown) {
    const flow = this.connectFlow;
    const step = flow?.step;
    if (!flow || !step || step.id !== stepId || step.type === "progress") {
      return;
    }
    // Do not retain submitted secrets while the Gateway runs the provider-owned step.
    if (step.sensitive) {
      this.stepValue = undefined;
    }
    void this.runAction(
      "answer",
      (target) =>
        target.client.request<UsersAuthConnectStatusResult>("users.authConnect.answer", {
          profileId: target.profileId,
          connectId: flow.connectId,
          stepId: step.id,
          ...(value !== undefined ? { value } : {}),
        }),
      (result) => this.applyConnectStatus(result),
    );
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(interval = 2000) {
    this.stopPoll();
    const flow = this.connectFlow;
    if (!flow || !this.target || this.action) {
      return;
    }
    const delay = Math.max(0, Math.min(interval, flow.expiresAtMs - Date.now()));
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollStatus();
    }, delay);
  }

  private async pollStatus() {
    const target = this.target;
    const flow = this.connectFlow;
    const generation = this.generation;
    if (!target || !flow || this.action) {
      return;
    }
    try {
      const result = await target.client.request<UsersAuthConnectStatusResult>(
        "users.authConnect.status",
        {
          profileId: target.profileId,
          connectId: flow.connectId,
        },
      );
      if (!this.isCurrent(target, generation) || this.connectFlow?.connectId !== flow.connectId) {
        return;
      }
      this.applyConnectStatus(result);
      if (this.connectFlow) {
        // Poll serially and only through the server deadline. If clocks disagree,
        // leave the attempt cancellable instead of inventing an expiry outcome.
        if (Date.now() >= flow.expiresAtMs) {
          this.statusUnavailable = true;
          this.error = t("profilePage.modelAccounts.statusTimedOut");
        } else {
          this.schedulePoll();
        }
      }
    } catch (error) {
      if (this.isCurrent(target, generation)) {
        this.statusUnavailable = true;
        this.error = formatUiError(error, t("profilePage.modelAccounts.statusFailed"));
      }
    }
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      return nothing;
    }
    const person = snapshot.selfUser?.id === this.identityId ? snapshot.selfUser : null;
    return renderModelAccountsSection(
      {
        gatewayUrl: (this.target?.client ?? snapshot.client).gatewayUrl,
        personLabel: person
          ? this.personLabel ||
            person.name ||
            person.email ||
            t("profilePage.modelAccounts.currentPerson")
          : null,
        unavailableReason: !person
          ? "identity"
          : hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
            ? "profile"
            : "write",
        onConnectionSettings: () => this.context.navigate("connection"),
      },
      this.target
        ? {
            links: this.links,
            accounts: this.accounts,
            hasMore: Boolean(this.nextCursor),
            inventoryLoading: this.inventoryLoading,
            inventoryError: this.inventoryError,
            showManualLink: this.target.canAdmin,
            busy: this.inventoryLoading || this.action !== null,
            cancelBusy: this.action !== null && this.action !== "answer",
            error: this.error,
            notice: this.notice ? t(`profilePage.modelAccounts.notices.${this.notice}`) : null,
            statusUnavailable: this.statusUnavailable,
            linkDraft: this.linkDraft,
            signIn: this.signIn,
            connectFlow: this.connectFlow,
            stepValue: this.stepValue,
            onLinkDraftInput: (value) => {
              this.linkDraft = value;
            },
            onLink: () => this.updateLink({ authProfileId: this.linkDraft.trim() }),
            onUnlink: (provider) => this.updateLink({ provider }),
            onSelectAccount: (authProfileId) => this.selectAccount(authProfileId),
            onLoadMore: () => void this.loadAccounts(this.nextCursor),
            onRefresh: () => void this.loadAccounts(),
            onAddAccount: () => this.openSignIn(),
            onProviderChange: (provider) => this.selectProvider(provider),
            onMethodChange: (method) => {
              if (this.signIn && !this.action && !this.connectFlow) {
                this.signIn = { ...this.signIn, method };
              }
            },
            onCloseSignIn: () => {
              if (!this.action && !this.connectFlow) {
                this.signIn = null;
                this.error = null;
              }
            },
            onConnectStart: () => this.startConnect(),
            onStepValueChange: (stepId, value) => {
              if (this.connectFlow?.step?.id === stepId) {
                this.stepValue = value;
              }
            },
            onStepAnswer: (stepId, value) => this.answerStep(stepId, value),
            onConnectCancel: () => this.connectStatus("cancel"),
            onConnectCheck: () => this.connectStatus("status"),
          }
        : null,
    );
  }
}

if (!customElements.get("openclaw-model-accounts")) {
  customElements.define("openclaw-model-accounts", ModelAccounts);
}
