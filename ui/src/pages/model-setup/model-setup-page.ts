import { consume } from "@lit/context";
import { initialState, Task } from "@lit/task";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";
import { findPreparedModelCandidate, type ModelSetupPrepareOption } from "./prepare-options.ts";
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
import { renderModelSetup, resolveSetupBrandIcon } from "./view.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";
import type { ModelSetupWizardStartMethod } from "./wizard-runner.ts";

const MODEL_SETUP_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

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

type BoundModelResult<T> =
  | { client: GatewayBrowserClient; value: T }
  | { client: GatewayBrowserClient; error: unknown };

type ActivationTaskResult = {
  result: SystemAgentSetupActivateResult;
  refreshError: string | null;
};

async function captureModelResult<T>(
  client: GatewayBrowserClient,
  load: () => Promise<T>,
): Promise<BoundModelResult<T>> {
  try {
    return { client, value: await load() };
  } catch (error) {
    return { client, error };
  }
}

export class ModelSetupPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelSetupRouteData | undefined;

  @state() private pageState: ModelSetupPageState = { phase: "loading" };
  @state() private activationState: ModelSetupActivationState = { phase: "idle" };
  @state() private verifyState: ModelSetupVerifyState = { phase: "idle" };
  @state() private wizardState: ModelSetupWizardState = { phase: "idle" };
  @state() private wizardMode: "auth" | "prepare" = "auth";
  @state() private wizardValue: unknown;
  @state() private manualProviderId = "";
  @state() private manualApiKey = "";
  @state() private manualError: string | null = null;
  @state() private moreSignInOpen = false;
  @state() private iconUrls: Record<string, string> = {};

  private observedClient: GatewayBrowserClient | null = null;
  private dataClient: GatewayBrowserClient | null = null;
  private pendingPrepareOption: ModelSetupPrepareOption | null = null;
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
    onDone: (startMethod) => void this.handleWizardDone(startMethod),
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
  });

  private readonly detectTask = new Task<
    readonly [GatewayBrowserClient | null, object | null],
    BoundModelResult<SystemAgentSetupDetectResult> & { token: object }
  >(this, {
    autoRun: false,
    args: () => {
      const client = this.context?.gateway.snapshot.client ?? null;
      return [this.canUseSetup(client) ? client : null, null] as const;
    },
    task: async ([client, token], { signal }) =>
      client && token
        ? { ...(await captureModelResult(client, () => detectModelSetup(client, signal))), token }
        : initialState,
    onComplete: (outcome) => {
      if (this.context.gateway.snapshot.client !== outcome.client) {
        return;
      }
      if ("error" in outcome) {
        this.pageState = { phase: "detect-error", message: errorMessage(outcome.error) };
        return;
      }
      this.pageState = { phase: "ready", result: outcome.value };
      this.dataClient = outcome.client;
      this.syncManualProvider(this.pageState);
    },
  });

  private readonly activationTask = new Task<
    readonly [GatewayBrowserClient | null, SystemAgentSetupActivateParams | null],
    BoundModelResult<ActivationTaskResult>
  >(this, {
    autoRun: false,
    args: () => [null, null],
    task: ([client, params], { signal }) => {
      if (!client || !params) {
        return initialState;
      }
      return captureModelResult(client, async () => {
        const mutation = await this.context.runtimeConfig.runExternalMutation((mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before model activation started.");
          }
          return mutationClient.request<SystemAgentSetupActivateResult>(
            "openclaw.setup.activate",
            params,
            {
              timeoutMs: activationTimeoutForKind(params.kind),
              signal,
            },
          );
        });
        if (!mutation.ok) {
          throw new Error(mutation.error);
        }
        return {
          result: mutation.value,
          refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
        };
      });
    },
    onComplete: (outcome) => {
      const current = this.activationState;
      if (current.phase !== "testing" || this.context.gateway.snapshot.client !== outcome.client) {
        return;
      }
      if ("error" in outcome) {
        this.activationState = {
          phase: "failure",
          targetId: current.targetId,
          status: "unknown",
          error: errorMessage(outcome.error),
        };
        return;
      }
      const activationState = mapActivationResult({
        result: outcome.value.result,
        targetId: current.targetId,
        fallbackError: t("modelSetup.errors.activationFailed"),
      });
      this.activationState =
        activationState.phase === "success" && outcome.value.refreshError
          ? { ...activationState, warning: outcome.value.refreshError }
          : activationState;
      if (this.activationState.phase === "success") {
        this.manualApiKey = "";
      }
    },
  });

  private readonly verifyTask = new Task<
    readonly [GatewayBrowserClient | null],
    BoundModelResult<Awaited<ReturnType<typeof verifyModelSetup>>>
  >(this, {
    autoRun: false,
    args: () => [null],
    task: ([client], { signal }) =>
      client ? captureModelResult(client, () => verifyModelSetup(client, signal)) : initialState,
    onComplete: (outcome) => {
      if (this.context.gateway.snapshot.client !== outcome.client) {
        return;
      }
      this.verifyState =
        "error" in outcome
          ? { phase: "failed", status: "unknown", error: errorMessage(outcome.error) }
          : mapVerifyResult(outcome.value);
    },
  });

  override disconnectedCallback() {
    void this.detectTask.run([null, null]);
    void this.activationTask.run([null, null]);
    void this.verifyTask.run([null]);
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
    void this.detectTask.run([null, null]);
    this.activationState = { phase: "idle" };
    void this.activationTask.run([null, null]);
    this.verifyState = { phase: "idle" };
    void this.verifyTask.run([null]);
    this.resetIcons();
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
      snapshot.phase === "connected" &&
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
        ...(result.unavailableCandidates ?? []),
        ...result.manualProviders,
        ...(result.authOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon && !resolveSetupBrandIcon(entry) ? [entry.icon] : [])),
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
          this.context.gateway.snapshot.phase !== "connected" ||
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
    this.resetVerify();
    this.pageState = { phase: "loading" };
    const token = {};
    await this.detectTask.run([client, token]);
    const outcome = this.detectTask.value;
    return outcome?.token === token && "value" in outcome ? outcome.value : null;
  }

  private canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return (
      this.canUseSetup(client) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true
    );
  }

  private resetVerify(): void {
    this.verifyState = { phase: "idle" };
    void this.verifyTask.run([null]);
  }

  private async verifyConnection(): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled()) {
      return;
    }
    this.verifyState = { phase: "checking" };
    await this.verifyTask.run([client]);
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
    this.manualError = null;
    this.activationState = { phase: "testing", targetId, modelRef };
    await this.activationTask.run([client, params]);
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

  private selectManualProvider(providerId: string): void {
    if (providerId !== this.manualProviderId) {
      this.manualApiKey = "";
    }
    this.manualProviderId = providerId;
    this.manualError = null;
  }

  private async useManualProvider(providerId: string): Promise<void> {
    this.selectManualProvider(providerId);
    await this.updateComplete;
    const input = this.renderRoot.querySelector<HTMLInputElement>(
      '.model-setup__manual input[type="password"]',
    );
    input?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    input?.focus();
  }

  private async handleWizardDone(startMethod: ModelSetupWizardStartMethod): Promise<void> {
    const prepareOption =
      startMethod === "openclaw.setup.prepare.start" ? this.pendingPrepareOption : null;
    this.pendingPrepareOption = null;
    const result = await this.detect();
    if (!result) {
      this.wizard.fail(t("modelSetup.errors.requestFailed"));
      return;
    }
    if (startMethod === "openclaw.setup.auth.start" && !result.setupComplete) {
      this.wizard.fail(t("modelSetup.wizard.notComplete"));
      return;
    }
    if (startMethod === "openclaw.setup.auth.start") {
      this.activationState = {
        phase: "success",
        modelRef: result.configuredModel ?? t("modelSetup.success.configuredModel"),
      };
    }
    if (prepareOption?.activateAfterPrepare) {
      const candidate = findPreparedModelCandidate(result, prepareOption.id);
      if (!candidate) {
        this.wizard.fail(t("modelSetup.prepare.llamaCppNotReady"));
        return;
      }
      this.wizard.close();
      this.activateCandidate(candidate);
      return;
    }
    this.wizard.close();
  }

  private cancelWizard(): void {
    this.pendingPrepareOption = null;
    void this.wizard.cancel();
  }

  private closeWizard(): void {
    this.pendingPrepareOption = null;
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
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    const canVerify =
      canAdmin &&
      !gatewayTooOld &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true;
    const body = renderModelSetup({
      page: this.pageState,
      activation: this.activationState,
      verify: this.verifyState,
      wizard: this.wizardState,
      wizardMode: this.wizardMode,
      wizardValue: this.wizardValue,
      canAdmin,
      canVerify,
      canPrepare:
        canAdmin &&
        !gatewayTooOld &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
      gatewayTooOld,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      firstRun: this.routeData?.firstRun === true,
      iconUrls: this.iconUrls,
      onDetect: () => void this.detect(),
      onVerify: () => void this.verifyConnection(),
      onActivateCandidate: (candidate) => this.activateCandidate(candidate),
      onStartAuth: (option: AuthOption) => {
        this.pendingPrepareOption = null;
        this.wizardMode = "auth";
        void this.wizard.start(option.id);
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        this.pendingPrepareOption = option;
        this.wizardMode = "prepare";
        void this.wizard.start(option.id, "openclaw.setup.prepare.start");
      },
      onManualProviderChange: (providerId) => this.selectManualProvider(providerId),
      onUseManualProvider: (providerId) => void this.useManualProvider(providerId),
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
      onSuccessClose: () => {
        this.activationState = { phase: "idle" };
        void this.detect();
      },
      onWizardValueChange: (value) => (this.wizardValue = value),
      onWizardAnswer: (value, includeValue) => void this.wizard.answer(value, includeValue),
      onWizardCancel: () => this.cancelWizard(),
      onWizardClose: () => this.closeWizard(),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("model-setup")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("model-setup")}
            ${renderDocsLink(MODEL_SETUP_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-model-setup-page")) {
  customElements.define("openclaw-model-setup-page", ModelSetupPage);
}
