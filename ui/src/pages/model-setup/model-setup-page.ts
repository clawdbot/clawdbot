import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";
import { detectModelSetup, verifyModelSetup } from "./rpc.ts";
import {
  activationTargetId,
  activationTimeoutForKind,
  initialWizardValue,
  mapActivationResult,
  mapVerifyResult,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupVerifyState,
  type ModelSetupWizardState,
} from "./state.ts";
import { renderModelSetup } from "./view.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];

export type ModelSetupRouteData = {
  state: ModelSetupPageState;
  client: GatewayBrowserClient | null;
  firstRun: boolean;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" && error.trim() ? error : t("modelSetup.errors.requestFailed");
}

export class ModelSetupPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelSetupRouteData | undefined;

  @state() private pageState: ModelSetupPageState = { phase: "loading" };
  @state() private activationState: ModelSetupActivationState = { phase: "idle" };
  @state() private verifyState: ModelSetupVerifyState = { phase: "idle" };
  @state() private wizardState: ModelSetupWizardState = { phase: "idle" };
  @state() private wizardValue: unknown;
  @state() private manualProviderId = "";
  @state() private manualApiKey = "";
  @state() private manualError: string | null = null;
  @state() private moreSignInOpen = false;
  @state() private iconUrls: Record<string, string> = {};

  private observedClient: GatewayBrowserClient | null = null;
  private dataClient: GatewayBrowserClient | null = null;
  private detectAbort: AbortController | null = null;
  private activationAbort: AbortController | null = null;
  private verifyAbort: AbortController | null = null;
  private detectEpoch = 0;
  private activationEpoch = 0;
  private verifyEpoch = 0;
  private readonly iconMisses = new Set<string>();
  private readonly iconRequests = new Map<
    string,
    { controller: AbortController; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.context?.gateway.snapshot.client ?? null,
    onChange: (next) => {
      const previousStep = this.wizardState.phase === "step" ? this.wizardState.step.id : null;
      this.wizardState = next;
      if (next.phase === "step" && next.step.id !== previousStep) {
        this.wizardValue = initialWizardValue(next.step);
      }
    },
    onDone: () => void this.handleWizardDone(),
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
  });

  override disconnectedCallback() {
    this.detectAbort?.abort();
    this.activationAbort?.abort();
    this.verifyAbort?.abort();
    this.resetIcons();
    void this.wizard.cancel();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") && this.routeData) {
      this.pageState = this.routeData.state;
      this.dataClient = this.routeData.client;
      this.observedClient = this.routeData.client;
      this.syncManualProvider(this.routeData.state);
    }
  }

  override updated() {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.client === this.observedClient) {
      this.reconcileIcons();
      return;
    }
    this.observedClient = snapshot.client;
    this.detectAbort?.abort();
    this.activationAbort?.abort();
    this.verifyAbort?.abort();
    this.resetIcons();
    this.activationState = { phase: "idle" };
    this.verifyState = { phase: "idle" };
    void this.wizard.cancel();
    if (!snapshot.client || snapshot.client === this.dataClient) {
      return;
    }
    this.pageState = { phase: "loading" };
    this.dataClient = snapshot.client;
    if (this.canUseSetup(snapshot.client)) {
      void this.detect();
    }
  }

  private canUseSetup(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return Boolean(
      client &&
      snapshot.connected &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true,
    );
  }

  private syncManualProvider(pageState: ModelSetupPageState): void {
    if (pageState.phase !== "ready") {
      return;
    }
    const available = pageState.result.manualProviders.some(
      (provider) => provider.id === this.manualProviderId,
    );
    if (!available) {
      this.manualProviderId = pageState.result.manualProviders[0]?.id ?? "";
    }
  }

  private currentIconUrls(): Set<string> {
    if (this.pageState.phase !== "ready") {
      return new Set();
    }
    const result = this.pageState.result;
    return new Set(
      [
        ...result.candidates,
        ...result.manualProviders,
        ...(result.authOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon ? [entry.icon] : [])),
    );
  }

  private reconcileIcons(): void {
    const eligible = this.currentIconUrls();
    const nextUrls = { ...this.iconUrls };
    let changed = false;
    for (const [iconUrl, blobUrl] of Object.entries(nextUrls)) {
      if (!eligible.has(iconUrl)) {
        URL.revokeObjectURL(blobUrl);
        delete nextUrls[iconUrl];
        changed = true;
      }
    }
    if (changed) {
      this.iconUrls = nextUrls;
    }
    for (const [iconUrl, request] of this.iconRequests) {
      if (!eligible.has(iconUrl)) {
        clearTimeout(request.timeout);
        request.controller.abort();
        this.iconRequests.delete(iconUrl);
      }
    }
    for (const iconUrl of this.iconMisses) {
      if (!eligible.has(iconUrl)) {
        this.iconMisses.delete(iconUrl);
      }
    }
    for (const iconUrl of eligible) {
      if (
        !this.iconUrls[iconUrl] &&
        !this.iconMisses.has(iconUrl) &&
        !this.iconRequests.has(iconUrl)
      ) {
        this.fetchIcon(iconUrl);
      }
    }
  }

  private fetchIcon(iconUrl: string): void {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("catalog icon fetch timed out", "TimeoutError")),
      10_000,
    );
    const request = { controller, timeout };
    this.iconRequests.set(iconUrl, request);
    void fetchCatalogIconBlobUrl({
      iconUrl,
      basePath: this.context.basePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
      signal: controller.signal,
    })
      .then((blobUrl) => {
        if (
          this.iconRequests.get(iconUrl) !== request ||
          !this.context.gateway.snapshot.connected ||
          !this.currentIconUrls().has(iconUrl)
        ) {
          if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
          }
          return;
        }
        if (blobUrl) {
          this.iconUrls = { ...this.iconUrls, [iconUrl]: blobUrl };
        } else {
          this.iconMisses.add(iconUrl);
        }
      })
      .catch(() => {
        if (this.iconRequests.get(iconUrl) === request) {
          this.iconMisses.add(iconUrl);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.iconRequests.get(iconUrl) === request) {
          this.iconRequests.delete(iconUrl);
        }
      });
  }

  private invalidateIcon(iconUrl: string): void {
    const request = this.iconRequests.get(iconUrl);
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
      this.iconRequests.delete(iconUrl);
    }
    const blobUrl = this.iconUrls[iconUrl];
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
    const next = { ...this.iconUrls };
    delete next[iconUrl];
    this.iconUrls = next;
    this.iconMisses.add(iconUrl);
  }

  private resetIcons(): void {
    for (const request of this.iconRequests.values()) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    for (const blobUrl of Object.values(this.iconUrls)) {
      URL.revokeObjectURL(blobUrl);
    }
    this.iconRequests.clear();
    this.iconMisses.clear();
    this.iconUrls = {};
  }

  private async detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client)) {
      return null;
    }
    const epoch = ++this.detectEpoch;
    this.resetVerify();
    this.detectAbort?.abort();
    const abortController = new AbortController();
    this.detectAbort = abortController;
    this.pageState = { phase: "loading" };
    try {
      const result = await detectModelSetup(client, abortController.signal);
      if (epoch !== this.detectEpoch || this.context.gateway.snapshot.client !== client) {
        return null;
      }
      this.pageState = { phase: "ready", result };
      this.dataClient = client;
      this.syncManualProvider(this.pageState);
      return result;
    } catch (error) {
      if (
        epoch === this.detectEpoch &&
        this.context.gateway.snapshot.client === client &&
        !abortController.signal.aborted
      ) {
        this.pageState = { phase: "detect-error", message: errorMessage(error) };
      }
      return null;
    } finally {
      if (this.detectAbort === abortController) {
        this.detectAbort = null;
      }
    }
  }

  private canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return (
      this.canUseSetup(client) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true
    );
  }

  private resetVerify(): void {
    this.verifyEpoch += 1;
    this.verifyAbort?.abort();
    this.verifyAbort = null;
    this.verifyState = { phase: "idle" };
  }

  private async verifyConnection(): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled()) {
      return;
    }
    const epoch = ++this.verifyEpoch;
    this.verifyAbort?.abort();
    const abortController = new AbortController();
    this.verifyAbort = abortController;
    this.verifyState = { phase: "checking" };
    try {
      const result = await verifyModelSetup(client, abortController.signal);
      if (epoch !== this.verifyEpoch || this.context.gateway.snapshot.client !== client) {
        return;
      }
      this.verifyState = mapVerifyResult(result);
    } catch (error) {
      if (
        epoch === this.verifyEpoch &&
        this.context.gateway.snapshot.client === client &&
        !abortController.signal.aborted
      ) {
        this.verifyState = { phase: "failed", status: "unknown", error: errorMessage(error) };
      }
    } finally {
      if (this.verifyAbort === abortController) {
        this.verifyAbort = null;
      }
    }
  }

  private async activate(
    params: SystemAgentSetupActivateParams,
    targetId: string,
    modelRef: string,
  ): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client) || this.actionsDisabled()) {
      return;
    }
    const epoch = ++this.activationEpoch;
    this.activationAbort?.abort();
    const abortController = new AbortController();
    this.activationAbort = abortController;
    this.manualError = null;
    this.activationState = { phase: "testing", targetId, modelRef };
    try {
      const result = await client.request<SystemAgentSetupActivateResult>(
        "openclaw.setup.activate",
        params,
        { timeoutMs: activationTimeoutForKind(params.kind), signal: abortController.signal },
      );
      if (epoch !== this.activationEpoch || this.context.gateway.snapshot.client !== client) {
        return;
      }
      this.activationState = mapActivationResult({
        result,
        targetId,
        fallbackError: t("modelSetup.errors.activationFailed"),
      });
      if (this.activationState.phase === "success") {
        this.manualApiKey = "";
      }
    } catch (error) {
      if (
        epoch === this.activationEpoch &&
        this.context.gateway.snapshot.client === client &&
        !abortController.signal.aborted
      ) {
        this.activationState = {
          phase: "failure",
          targetId,
          status: "unknown",
          error: errorMessage(error),
        };
      }
    } finally {
      if (this.activationAbort === abortController) {
        this.activationAbort = null;
      }
    }
  }

  private activateCandidate(candidate: Candidate): void {
    void this.activate(
      { kind: candidate.kind, modelRef: candidate.modelRef },
      activationTargetId(candidate.kind, candidate.modelRef),
      candidate.modelRef,
    );
  }

  private connectManual(): void {
    const apiKey = this.manualApiKey.trim();
    if (!this.manualProviderId || !apiKey) {
      this.manualError = t("modelSetup.manual.required");
      return;
    }
    void this.activate(
      { kind: "api-key", authChoice: this.manualProviderId, apiKey },
      `manual:${this.manualProviderId}`,
      this.manualProviderId,
    );
  }

  private async handleWizardDone(): Promise<void> {
    const result = await this.detect();
    if (!result) {
      this.wizard.fail(t("modelSetup.errors.requestFailed"));
      return;
    }
    if (!result.setupComplete) {
      this.wizard.fail(t("modelSetup.wizard.notComplete"));
      return;
    }
    this.activationState = {
      phase: "success",
      modelRef: result.configuredModel ?? t("modelSetup.success.configuredModel"),
    };
    this.wizard.close();
  }

  private actionsDisabled(): boolean {
    return (
      this.activationState.phase === "testing" ||
      this.verifyState.phase === "checking" ||
      (this.wizardState.phase !== "idle" &&
        this.wizardState.phase !== "error" &&
        this.wizardState.phase !== "cancelled")
    );
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.connected && isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    const canVerify =
      canAdmin &&
      !gatewayTooOld &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true;
    const body = renderModelSetup({
      page: this.pageState,
      activation: this.activationState,
      verify: this.verifyState,
      wizard: this.wizardState,
      wizardValue: this.wizardValue,
      canAdmin,
      canVerify,
      gatewayTooOld,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      iconUrls: this.iconUrls,
      onDetect: () => void this.detect(),
      onVerify: () => void this.verifyConnection(),
      onActivateCandidate: (candidate) => this.activateCandidate(candidate),
      onStartAuth: (option: AuthOption) => void this.wizard.start(option.id),
      onManualProviderChange: (providerId) => {
        this.manualProviderId = providerId;
        this.manualError = null;
      },
      onManualApiKeyChange: (apiKey) => {
        this.manualApiKey = apiKey;
        this.manualError = null;
      },
      onManualConnect: () => this.connectManual(),
      onMoreSignInToggle: (open) => (this.moreSignInOpen = open),
      onIconError: (iconUrl) => this.invalidateIcon(iconUrl),
      onOpenChat: () => {
        if (this.routeData?.firstRun) {
          this.context.navigate("custodian", { search: "?onboarding=1" });
          return;
        }
        this.context.navigate("chat");
      },
      onWizardValueChange: (value) => (this.wizardValue = value),
      onWizardAnswer: (value, includeValue) => void this.wizard.answer(value, includeValue),
      onWizardCancel: () => void this.wizard.cancel(),
      onWizardClose: () => this.wizard.close(),
    });
    return html`
      <section class="content-header">
        <div class="page-title">${titleForRoute("model-setup")}</div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-model-setup-page")) {
  customElements.define("openclaw-model-setup-page", ModelSetupPage);
}
