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
import { detectModelSetup } from "./rpc.ts";
import {
  activationTargetId,
  activationTimeoutForKind,
  initialWizardValue,
  mapActivationResult,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupWizardState,
} from "./state.ts";
import { renderModelSetup } from "./view.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];

export type ModelSetupRouteData = {
  state: ModelSetupPageState;
  client: GatewayBrowserClient | null;
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
  @state() private wizardState: ModelSetupWizardState = { phase: "idle" };
  @state() private wizardValue: unknown;
  @state() private manualProviderId = "";
  @state() private manualApiKey = "";
  @state() private manualError: string | null = null;
  @state() private moreSignInOpen = false;

  private observedClient: GatewayBrowserClient | null = null;
  private dataClient: GatewayBrowserClient | null = null;
  private detectAbort: AbortController | null = null;
  private activationAbort: AbortController | null = null;
  private detectEpoch = 0;
  private activationEpoch = 0;
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
      return;
    }
    this.observedClient = snapshot.client;
    this.detectAbort?.abort();
    this.activationAbort?.abort();
    this.activationState = { phase: "idle" };
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

  private async detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client)) {
      return null;
    }
    const epoch = ++this.detectEpoch;
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
    const body = renderModelSetup({
      page: this.pageState,
      activation: this.activationState,
      wizard: this.wizardState,
      wizardValue: this.wizardValue,
      canAdmin,
      gatewayTooOld,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      onDetect: () => void this.detect(),
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
      onOpenChat: () => this.context.navigate("chat"),
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

customElements.define("openclaw-model-setup-page", ModelSetupPage);
