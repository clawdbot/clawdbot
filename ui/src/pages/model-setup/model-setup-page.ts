import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
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
import { readSessionDefaults } from "../../app/gateway-store.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { ModelSetupDetectionConnection } from "./detect-cache.ts";
import { FirstRunAutoSetup, type ModelSetupRouteData } from "./first-run-auto-setup.ts";
import { ModelSetupIconLoader } from "./model-setup-icon-loader.ts";
import {
  captureModelSetupResult,
  formatModelSetupError,
  type ModelSetupActivationTaskResult,
  type ModelSetupTaskResult,
} from "./model-setup-task-result.ts";
import {
  findPreparedModelCandidate,
  type ModelSetupPrepareOption,
  providerAutoSetupKind,
} from "./prepare-options.ts";
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
import type { ModelSetupWizardCompletion, ModelSetupWizardStartMethod } from "./wizard-runner.ts";

export type { ModelSetupRouteData } from "./first-run-auto-setup.ts";

const MODEL_SETUP_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];

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
  @state() private setupRefreshWarning: string | null = null;

  private observedConnection: (ModelSetupRouteData["connection"] & { connected: boolean }) | null =
    null;
  private pendingPrepareOption: ModelSetupPrepareOption | null = null;
  private wizardMutationGeneration = 0;
  private wizardMutationActive = false;
  private readonly firstRun = new FirstRunAutoSetup({
    context: () => this.context,
    routeData: () => this.routeData,
    pageState: () => this.pageState,
    actionsDisabled: () => this.actionsDisabled(),
    canUseSetup: (client) => this.canUseSetup(client),
    canVerify: (client) => this.canVerify(client),
    activationSuccessful: () => this.activationState.phase === "success",
    verify: () => this.verifyConnection().then(() => this.verifyTask.value),
    activate: (candidate, targetId) =>
      this.activate(
        { kind: candidate.kind, modelRef: candidate.modelRef },
        targetId,
        candidate.modelRef,
      ).then(() => this.activationTask.value),
    setVerifyState: (next) => (this.verifyState = next),
    setActivationState: (next) => (this.activationState = next),
    setRefreshWarning: (warning) => (this.setupRefreshWarning = warning),
  });
  private readonly iconLoader = new ModelSetupIconLoader(
    () => this.context,
    (iconUrl) => this.currentIconUrls().has(iconUrl),
    (urls) => (this.iconUrls = urls),
  );
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeGateway(gateway.snapshot),
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => this.synchronizeGateway(this.context.gateway.snapshot),
    );
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.context?.gateway.snapshot.client ?? null,
    getAgentId: () => this.context?.agentSelection.state.selectedId ?? null,
    onChange: (next) => {
      const previousStep = this.wizardState.phase === "step" ? this.wizardState.step.id : null;
      this.wizardState =
        next.phase === "step" && this.wizardMutationActive ? { ...next, busy: true } : next;
      if (next.phase === "step" && next.step.id !== previousStep) {
        this.wizardValue = initialWizardValue(next.step);
      }
    },
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
  });

  private readonly detectTask = new Task<
    readonly [GatewayBrowserClient | null, string | null, object | null],
    ModelSetupTaskResult<SystemAgentSetupDetectResult> & {
      agentId: string | null;
      hello: ModelSetupDetectionConnection["hello"];
      token: object;
    }
  >(this, {
    autoRun: false,
    args: () => {
      const client = this.context?.gateway.snapshot.client ?? null;
      return [
        this.canUseSetup(client) ? client : null,
        this.context?.agentSelection.state.selectedId ?? null,
        null,
      ] as const;
    },
    task: async ([client, agentId, token], { signal }) => {
      if (!client || !token) {
        return initialState;
      }
      const hello = this.context.gateway.snapshot.hello;
      return {
        ...(await captureModelSetupResult(client, () =>
          detectModelSetup(client, agentId ?? undefined, signal),
        )),
        agentId,
        hello,
        token,
      };
    },
    onComplete: (outcome) => {
      if (
        this.context.gateway.snapshot.client !== outcome.client ||
        this.context.gateway.snapshot.hello !== outcome.hello ||
        this.context.agentSelection.state.selectedId !== outcome.agentId
      ) {
        return;
      }
      if ("error" in outcome) {
        this.firstRun.setReadyConnection(null);
        this.pageState = { phase: "detect-error", message: formatModelSetupError(outcome.error) };
        return;
      }
      this.firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      this.pageState = { phase: "ready", result: outcome.value };
      this.syncManualProvider(this.pageState);
    },
  });

  private readonly activationTask = new Task<
    readonly [GatewayBrowserClient | null, SystemAgentSetupActivateParams | null],
    ModelSetupTaskResult<ModelSetupActivationTaskResult>
  >(this, {
    autoRun: false,
    args: () => [null, null],
    task: ([client, params], { signal }) => {
      if (!client || !params) {
        return initialState;
      }
      return captureModelSetupResult(client, async () => {
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
          error: formatModelSetupError(outcome.error),
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
    readonly [GatewayBrowserClient | null, string | null],
    ModelSetupTaskResult<Awaited<ReturnType<typeof verifyModelSetup>>> & { agentId: string | null }
  >(this, {
    autoRun: false,
    args: () => [null, null],
    task: async ([client, agentId], { signal }) =>
      client
        ? {
            ...(await captureModelSetupResult(client, () =>
              verifyModelSetup(client, agentId ?? undefined, signal),
            )),
            agentId,
          }
        : initialState,
    onComplete: (outcome) => {
      if (
        this.context.gateway.snapshot.client !== outcome.client ||
        this.context.agentSelection.state.selectedId !== outcome.agentId
      ) {
        return;
      }
      this.verifyState =
        "error" in outcome
          ? { phase: "failed", status: "unknown", error: formatModelSetupError(outcome.error) }
          : mapVerifyResult(outcome.value);
    },
  });

  override disconnectedCallback() {
    this.firstRun.dispose();
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    void this.detectTask.run([null, null, null]);
    void this.activationTask.run([null, null]);
    void this.verifyTask.run([null, null]);
    this.iconLoader.reset();
    void this.wizard.cancel();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    const snapshot = this.context.gateway.snapshot;
    if (changed.has("routeData")) {
      this.firstRun.routeChanged();
    }
    if (changed.has("routeData") && this.routeData) {
      const { connection } = this.routeData;
      const current =
        snapshot.phase === "connected" &&
        snapshot.client === connection.client &&
        snapshot.hello === connection.hello &&
        this.context.agentSelection.state.selectedId === connection.agentId;
      if (current) {
        this.pageState = this.routeData.state;
        this.firstRun.setReadyConnection(this.pageState.phase === "ready" ? connection : null);
        this.observedConnection = { ...connection, connected: true };
        this.syncManualProvider(this.pageState);
      } else if (this.routeData.firstRun) {
        // A stale route completion cannot lend previously rendered candidates
        // to the current Gateway; detection must mint this generation's result.
        this.pageState = { phase: "loading" };
      }
    }
  }

  override updated() {
    this.synchronizeGateway(this.context.gateway.snapshot);
    this.iconLoader.reconcile(this.currentIconUrls());
    this.firstRun.start();
  }

  private synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]): void {
    const connection = {
      client: snapshot.client,
      hello: snapshot.hello,
      agentId: this.context.agentSelection.state.selectedId,
      connected: snapshot.phase === "connected",
    };
    if (!this.observedConnection) {
      this.observedConnection = connection;
      this.ensureRouteSettledDetection();
      return;
    }
    if (
      connection.client === this.observedConnection.client &&
      connection.hello === this.observedConnection.hello &&
      connection.agentId === this.observedConnection.agentId &&
      connection.connected === this.observedConnection.connected
    ) {
      this.ensureRouteSettledDetection();
      return;
    }
    this.observedConnection = connection;
    this.firstRun.connectionChanged(connection);
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    void this.detectTask.run([null, null, null]);
    this.activationState = { phase: "idle" };
    void this.activationTask.run([null, null]);
    this.verifyState = { phase: "idle" };
    void this.verifyTask.run([null, null]);
    this.iconLoader.reset();
    this.pendingPrepareOption = null;
    void this.wizard.cancel();
    this.pageState = { phase: "loading" };
    if (!connection.connected || !connection.client) {
      return;
    }
    if (this.canUseSetup(connection.client)) {
      void this.detect();
    }
  }

  // Route data can settle after mount and be discarded as another
  // connection's result. Nothing else re-arms detection then, so a loading
  // page with a connected, capable Gateway self-heals here instead of
  // dead-ending silently.
  private ensureRouteSettledDetection(): void {
    if (
      !this.hasUpdated ||
      !this.routeData ||
      this.pageState.phase !== "loading" ||
      this.detectTask.status !== TaskStatus.INITIAL
    ) {
      return;
    }
    if (this.canUseSetup(this.context.gateway.snapshot.client)) {
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
    if (
      !pageState.result.manualProviders.some((provider) => provider.id === this.manualProviderId)
    ) {
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
        ...(result.prepareOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon && !resolveSetupBrandIcon(entry) ? [entry.icon] : [])),
    );
  }

  private async detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client)) {
      return null;
    }
    this.resetVerify();
    this.pageState = { phase: "loading" };
    const token = {};
    await this.detectTask.run([client, this.context.agentSelection.state.selectedId, token]);
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
    void this.verifyTask.run([null, null]);
  }

  private async verifyConnection(): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled()) {
      return;
    }
    this.verifyState = { phase: "checking" };
    await this.verifyTask.run([client, this.context.agentSelection.state.selectedId]);
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
    const agentId = this.context.agentSelection.state.selectedId;
    await this.activationTask.run([client, { ...params, ...(agentId ? { agentId } : {}) }]);
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

  private async handleWizardDone(
    startMethod: ModelSetupWizardStartMethod,
    preparedModelRef?: string,
  ): Promise<void> {
    const prepareOption =
      startMethod === "openclaw.setup.prepare.start" ? this.pendingPrepareOption : null;
    this.pendingPrepareOption = null;
    if (prepareOption && preparedModelRef) {
      const kind = providerAutoSetupKind(prepareOption.id);
      this.wizard.close();
      void this.activate(
        { kind, modelRef: preparedModelRef },
        activationTargetId(kind, preparedModelRef),
        preparedModelRef,
      );
      return;
    }
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
    if (prepareOption) {
      // Provider setup can persist a model before the live activation check.
      // Keep that unverified config out of the ready surface until activation succeeds.
      this.pageState = {
        phase: "ready",
        result: { ...result, configuredModel: undefined, setupComplete: false },
      };
      const candidate = findPreparedModelCandidate(result, prepareOption.id);
      if (!candidate) {
        this.wizard.fail(
          t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }),
        );
        return;
      }
      this.wizard.close();
      this.activateCandidate(candidate);
      return;
    }
    this.wizard.close();
  }

  private closeWizard(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    this.pendingPrepareOption = null;
    this.wizard.close();
  }

  private async runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
  ): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (this.wizardMutationActive || !this.canUseSetup(client)) {
      return;
    }
    const generation = ++this.wizardMutationGeneration;
    this.wizardMutationActive = true;
    this.requestUpdate();
    try {
      const mutation = await this.context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before model setup continued.");
          }
          return await task();
        },
        {
          canDispatch: () =>
            generation === this.wizardMutationGeneration &&
            this.context.gateway.snapshot.client === client &&
            this.canUseSetup(client),
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (generation !== this.wizardMutationGeneration) {
        if (mutation.ok && !mutation.refresh.ok && this.isConnected) {
          this.setupRefreshWarning = mutation.refresh.error;
        }
        if (this.isConnected && this.canUseSetup(this.context.gateway.snapshot.client)) {
          void this.detect();
        }
        return;
      }
      if (!mutation.ok) {
        this.wizard.fail(mutation.error);
        return;
      }
      this.setupRefreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        this.wizardMutationActive = false;
        await this.handleWizardDone(completion.startMethod, completion.preparedModelRef);
      } else if (this.wizardState.phase === "step" && this.wizardState.busy) {
        this.wizardState = { ...this.wizardState, busy: false };
      }
    } catch (error) {
      if (generation === this.wizardMutationGeneration) {
        this.wizard.fail(formatModelSetupError(error));
      }
    } finally {
      if (generation === this.wizardMutationGeneration) {
        this.wizardMutationActive = false;
        this.requestUpdate();
      }
    }
  }

  private cancelWizard(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    this.pendingPrepareOption = null;
    // A Gateway-owned step can commit while cancellation is being handled.
    // Hide this generation now, but let its mutation lane settle and refresh.
    void this.wizard.cancel({ settleActiveRequest: true });
  }

  private actionsDisabled(): boolean {
    return (
      this.activationState.phase === "testing" ||
      this.verifyState.phase === "checking" ||
      this.wizardMutationActive ||
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
      page: this.firstRun.visiblePageState(this.verifyState.phase === "ok"),
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
      modelConfigured: snapshot.hello
        ? readSessionDefaults(snapshot.hello)?.modelConfigured === true
        : false,
      gatewayTooOld,
      refreshWarning: this.setupRefreshWarning,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      firstRun: this.routeData?.firstRun === true,
      iconUrls: this.iconUrls,
      onDetect: () => {
        this.firstRun.retryDetection();
        void this.detect();
      },
      onVerify: () => void this.verifyConnection(),
      onActivateCandidate: (candidate) => this.activateCandidate(candidate),
      onStartAuth: (option: AuthOption) => {
        this.pendingPrepareOption = null;
        this.wizardMode = "auth";
        void this.runWizardMutation(() => this.wizard.start(option.id));
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        this.pendingPrepareOption = option;
        this.wizardMode = "prepare";
        void this.runWizardMutation(() =>
          this.wizard.start(option.id, "openclaw.setup.prepare.start"),
        );
      },
      onManualProviderChange: (providerId) => this.selectManualProvider(providerId),
      onUseManualProvider: (providerId) => void this.useManualProvider(providerId),
      onManualApiKeyChange: (apiKey) => {
        this.manualApiKey = apiKey;
        this.manualError = null;
      },
      onManualConnect: () => this.connectManual(),
      onMoreSignInToggle: (open) => (this.moreSignInOpen = open),
      onIconError: (iconUrl) => this.iconLoader.invalidate(iconUrl),
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
      onWizardAnswer: (value, includeValue) =>
        void this.runWizardMutation(() => this.wizard.answer(value, includeValue)),
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
