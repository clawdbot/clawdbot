import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { detectModelSetup } from "../model-setup/rpc.ts";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import { modelProviderErrorMessage } from "./config-mutation.ts";
import {
  buildUnconfiguredProviderOptions,
  type ModelProviderCard,
  type ProviderOption,
} from "./data.ts";
import type { ModelProviderRowMessage } from "./view.ts";
import "../../styles/model-setup.css";

type ProviderSetupOwner = {
  getContext: () => ApplicationContext;
  getAgentId: () => string;
  canMutate: () => boolean;
  refreshProviders: () => Promise<void>;
};

/** Config-only setup shares the provider wizard, not primary-model activation. */
export class ModelProviderSetupController implements ReactiveController {
  open = false;
  selectedChoice = "";
  inventory: SystemAgentSetupDetectResult | null = null;
  loading = false;
  busy = false;
  message: ModelProviderRowMessage | undefined;
  messageTarget = "add";
  targetProviderId: string | null = null;
  private generation = 0;
  private discovery: AbortController | null = null;
  private wizardState: ModelSetupWizardState = { phase: "idle" };
  private wizardValue: unknown;
  private refreshWarning: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private activeSetup: { providerName: string; messageTarget: string } | undefined;
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.owner.getContext().gateway.snapshot.client,
    getAgentId: () => this.owner.getAgentId(),
    onChange: (next) => {
      const previousStep = this.wizardState.phase === "step" ? this.wizardState.step.id : null;
      this.wizardState = next.phase === "step" && this.busy ? { ...next, busy: true } : next;
      if (next.phase !== "step") {
        this.wizardValue = undefined;
      } else if (next.step.id !== previousStep) {
        this.wizardValue = initialWizardValue(next.step);
      }
      this.host.requestUpdate();
    },
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
  });

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly owner: ProviderSetupOwner,
  ) {
    host.addController(this);
  }

  get available(): boolean {
    const snapshot = this.owner.getContext().gateway.snapshot;
    return (
      canCallGatewayMethod(snapshot, "openclaw.setup.detect", "operator.admin") &&
      canCallGatewayMethod(snapshot, "openclaw.setup.prepare.start", "operator.admin")
    );
  }

  hostUpdated(): void {
    if (this.wizardState.phase !== "idle") {
      this.host.querySelector("openclaw-modal-dialog")?.setReturnFocusTarget(this.returnFocus);
    }
  }

  hostDisconnected(): void {
    this.reset();
  }

  reset(): void {
    this.generation += 1;
    this.discovery?.abort();
    this.discovery = null;
    this.open = false;
    this.selectedChoice = "";
    this.inventory = null;
    this.loading = false;
    this.busy = false;
    this.message = undefined;
    this.messageTarget = "add";
    this.targetProviderId = null;
    this.activeSetup = undefined;
    this.refreshWarning = null;
    this.returnFocus = null;
    // Cancellation can race a commit; keep its coordinated request alive through refresh.
    void this.wizard.cancel({ settleActiveRequest: true });
    this.host.requestUpdate();
  }

  select(authChoice: string): void {
    this.selectedChoice = authChoice;
    this.host.requestUpdate();
  }

  async load(): Promise<void> {
    if (!this.available || !this.owner.canMutate()) {
      return;
    }
    this.reset();
    const generation = this.generation;
    const client = this.owner.getContext().gateway.snapshot.client;
    if (!client) {
      return;
    }
    const discovery = new AbortController();
    this.discovery = discovery;
    this.open = true;
    this.loading = true;
    this.host.requestUpdate();
    try {
      const inventory = await detectModelSetup(client, this.owner.getAgentId(), discovery.signal);
      if (generation === this.generation) {
        this.inventory = inventory;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.message = { kind: "error", text: modelProviderErrorMessage(error) };
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.discovery = null;
        this.host.requestUpdate();
      }
    }
  }

  start(): Promise<void> {
    const choice = buildUnconfiguredProviderOptions(this.inventory, []).find(
      (entry) => entry.id === this.selectedChoice,
    );
    return choice ? this.startSetup(choice, "add") : Promise.resolve();
  }

  startChoice(
    providerId: string,
    providerName: string,
    action: NonNullable<ModelProviderCard["setupActions"]>[number],
  ): Promise<void> {
    return this.startSetup(
      {
        id: action.choiceId,
        displayName: providerName,
        providerName,
        ...(action.hint ? { hint: action.hint } : {}),
      },
      providerId,
    );
  }

  private startSetup(choice: ProviderOption, messageTarget: string): Promise<void> {
    if (this.activeSetup || this.busy || !this.available || !this.owner.canMutate()) {
      return Promise.resolve();
    }
    this.activeSetup = {
      providerName: choice.providerName,
      messageTarget,
    };
    return this.run(() => this.wizard.start(choice.id, "openclaw.setup.prepare.start"));
  }

  private async run(task: () => Promise<ModelSetupWizardCompletion | null>): Promise<void> {
    const setup = this.activeSetup;
    if (!setup || this.busy || !this.available || !this.owner.canMutate()) {
      return;
    }
    const context = this.owner.getContext();
    const { client, hello } = context.gateway.snapshot;
    const agentId = this.owner.getAgentId();
    const generation = ++this.generation;
    const isCurrent = () =>
      generation === this.generation &&
      this.host.isConnected &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.hello === hello &&
      this.owner.getAgentId() === agentId;
    if (this.wizard.state.phase === "idle") {
      const active = this.host.ownerDocument.activeElement;
      this.returnFocus =
        active instanceof HTMLElement && this.host.contains(active) ? active : null;
    }
    this.busy = true;
    this.targetProviderId = setup.messageTarget === "add" ? null : setup.messageTarget;
    this.message = undefined;
    this.messageTarget = setup.messageTarget;
    this.host.requestUpdate();
    try {
      const result = await context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before provider setup continued.");
          }
          return task();
        },
        {
          canDispatch: () => isCurrent() && this.available,
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (!isCurrent()) {
        return;
      }
      if (!result.ok) {
        this.wizard.fail(result.error);
        return;
      }
      this.refreshWarning = result.refresh.ok ? null : result.refresh.error;
      if (result.value) {
        this.busy = false;
        if (setup.messageTarget === "add") {
          // The completed add form disappears; return focus to its durable toggle.
          this.host
            .querySelector("openclaw-modal-dialog")
            ?.setReturnFocusTarget(
              this.host.querySelector<HTMLButtonElement>("[data-provider-setup-toggle]"),
            );
        }
        this.wizard.close();
        this.open = false;
        this.selectedChoice = "";
        this.activeSetup = undefined;
        const message = {
          kind: "success" as const,
          text: t("modelProviders.add.saved", { provider: setup.providerName }),
        };
        this.message = message;
        try {
          if (result.refresh.ok) {
            await this.owner.refreshProviders();
          }
        } catch (error) {
          if (isCurrent()) {
            this.refreshWarning = modelProviderErrorMessage(error);
          }
        }
        if (isCurrent() && this.refreshWarning) {
          this.message = { ...message, warning: this.refreshWarning };
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.wizard.fail(modelProviderErrorMessage(error));
      }
    } finally {
      if (isCurrent()) {
        this.busy = false;
        this.targetProviderId = null;
        if (this.wizardState.phase === "step") {
          this.wizardState = { ...this.wizardState, busy: false };
        }
        this.host.requestUpdate();
      }
    }
  }

  private cancelWizard(): void {
    this.generation += 1;
    this.busy = false;
    this.activeSetup = undefined;
    this.targetProviderId = null;
    void this.wizard.cancel({ settleActiveRequest: true });
  }

  renderWizard() {
    return renderModelSetupWizard({
      mode: "prepare",
      state: this.wizardState,
      refreshWarning: this.refreshWarning,
      value: this.wizardValue,
      onValueChange: (value) => {
        this.wizardValue = value;
        this.host.requestUpdate();
      },
      onAnswer: (value, includeValue) =>
        void this.run(() => this.wizard.answer(value, includeValue)),
      onCancel: () => this.cancelWizard(),
      onClose: () => this.cancelWizard(),
    });
  }
}
