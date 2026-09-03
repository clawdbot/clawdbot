import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../styles/model-setup.css";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import type { ModelProviderAccessOption } from "./data.ts";
import type { ModelProviderRowMessage } from "./view.ts";

type ModelProviderLoginControllerOptions = {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  getRuntimeConfig: () => Pick<RuntimeConfigCapability, "runExternalMutation">;
  canStart: () => boolean;
  refresh: () => Promise<void>;
  setMessage: (key: string, message: ModelProviderRowMessage | null) => void;
};

export class ModelProviderLoginController implements ReactiveController {
  private state: ModelSetupWizardState = { phase: "idle" };
  private mode: "auth" | "prepare" = "auth";
  private value: unknown;
  private cardId: string | null = null;
  private mutationGeneration = 0;
  private mutationActive = false;
  // Keep sign-in disabled until terminal status confirms that shared Gateway
  // admission is free; an early replacement would surface a false busy error.
  private cancellationPending = false;
  private readonly runner: ModelSetupWizardRunner;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: ModelProviderLoginControllerOptions,
  ) {
    host.addController(this);
    this.runner = new ModelSetupWizardRunner({
      getClient: options.getClient,
      getAgentId: options.getAgentId,
      onChange: (next) => {
        const previousStep = this.state.phase === "step" ? this.state.step.id : null;
        this.state = next;
        if (next.phase === "step" && next.step.id !== previousStep) {
          this.value = initialWizardValue(next.step);
        }
        this.host.requestUpdate();
      },
      requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
      cancelledMessage: () => t("modelSetup.wizard.cancelled"),
      sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    });
  }

  get busy(): boolean {
    return this.mutationActive || this.state.phase !== "idle" || this.cancellationPending;
  }

  start(cardId: string, option: ModelProviderAccessOption): void {
    if (!this.options.canStart() || this.busy) {
      return;
    }
    this.cardId = cardId;
    this.mode = option.mode === "login" ? "auth" : "prepare";
    this.options.setMessage(cardId, null);
    void this.runWizardMutation(() =>
      this.runner.start(
        option.id,
        option.mode === "login" ? "openclaw.setup.auth.start" : "openclaw.setup.prepare.start",
      ),
    );
  }

  reset(): void {
    this.mutationGeneration += 1;
    this.mutationActive = false;
    this.cardId = null;
    if (this.cancellationPending) {
      return;
    }
    this.cancellationPending = true;
    void this.runner.cancel({ waitForRelease: true }).finally(() => {
      this.cancellationPending = false;
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.reset();
  }

  render() {
    return renderModelSetupWizard({
      mode: this.mode,
      state: this.state,
      refreshWarning: null,
      value: this.value,
      onValueChange: (value) => {
        this.value = value;
        this.host.requestUpdate();
      },
      onAnswer: (value, includeValue) => {
        void this.runWizardMutation(() => this.runner.answer(value, includeValue));
      },
      onCancel: () => this.reset(),
      onClose: () => this.reset(),
    });
  }

  private async runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
  ): Promise<void> {
    const client = this.options.getClient();
    if (!client || this.mutationActive || !this.options.canStart()) {
      return;
    }
    const generation = ++this.mutationGeneration;
    this.mutationActive = true;
    this.host.requestUpdate();
    try {
      const mutation = await this.options.getRuntimeConfig().runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before provider login continued.");
          }
          return await task();
        },
        {
          canDispatch: () =>
            generation === this.mutationGeneration &&
            this.options.getClient() === client &&
            this.options.canStart(),
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (generation !== this.mutationGeneration) {
        return;
      }
      if (!mutation.ok) {
        this.runner.fail(mutation.error);
        return;
      }
      await this.finish(mutation.value, mutation.refresh.ok ? undefined : mutation.refresh.error);
    } catch (error) {
      if (generation === this.mutationGeneration) {
        this.runner.fail(formatUiError(error, t("modelSetup.errors.requestFailed")));
      }
    } finally {
      if (generation === this.mutationGeneration) {
        this.mutationActive = false;
        this.host.requestUpdate();
      }
    }
  }

  private async finish(completion: ModelSetupWizardCompletion | null, refreshWarning?: string) {
    if (
      !completion ||
      (completion.startMethod !== "openclaw.setup.auth.start" &&
        completion.startMethod !== "openclaw.setup.prepare.start")
    ) {
      return;
    }
    const cardId = this.cardId;
    this.cardId = null;
    this.runner.close();
    this.state = { phase: "idle" };
    if (cardId) {
      this.options.setMessage(cardId, {
        kind: "success",
        text: t(
          completion.startMethod === "openclaw.setup.auth.start"
            ? "modelProviders.login.done"
            : "common.configured",
        ),
        ...(refreshWarning ? { warning: refreshWarning } : {}),
      });
    }
    this.host.requestUpdate();
    await this.options.refresh();
    this.host.requestUpdate();
  }
}
