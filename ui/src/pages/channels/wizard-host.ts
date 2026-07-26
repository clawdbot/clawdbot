// Page-side host for the channel setup wizard: owns the RPC controller,
// per-step multiselect state, dirty-config guarding, and completion effects
// (config resync + WhatsApp QR handoff) so the page element stays thin.
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { ChannelWizardController, type ChannelWizardState } from "./wizard-controller.ts";

type WizardHostDeps = {
  getContext: () => ApplicationContext | undefined;
  requestUpdate: () => void;
  /** Close any open detail overlay before the wizard modal opens. */
  clearSelection: () => void;
};

export class ChannelWizardHost {
  multiselect: unknown[] = [];
  blockedByDirtyConfig = false;
  private multiselectStepId: string | null = null;
  private lastPhase = "idle";
  private readonly controller: ChannelWizardController;

  /** Account the completed wizard configured for WhatsApp QR pairing. */
  whatsappAccountId: string | undefined;

  constructor(private readonly deps: WizardHostDeps) {
    this.controller = new ChannelWizardController(
      () => deps.getContext()?.gateway.snapshot.client ?? null,
      () => this.handleControllerChange(),
      (value) =>
        deps
          .getContext()
          ?.channels.state.channelsSnapshot?.channelMeta?.some((entry) => entry.id === value) ??
        false,
      () => t("channels.setup.sessionExpired"),
    );
  }

  get state(): ChannelWizardState {
    return this.controller.state;
  }

  startSetup(channel: string | null): void {
    // Wizard completion resyncs config from disk (discarding local drafts), so
    // refuse to start while the advanced form holds unsaved edits.
    if (this.deps.getContext()?.runtimeConfig.state.configFormDirty) {
      this.blockedByDirtyConfig = true;
      this.deps.requestUpdate();
      return;
    }
    this.blockedByDirtyConfig = false;
    this.whatsappAccountId = undefined;
    this.deps.clearSelection();
    void this.controller.start(channel);
  }

  close(): void {
    const wasActive = this.controller.state.phase !== "idle";
    void this.controller.cancel();
    if (wasActive) {
      void this.deps.getContext()?.channels.refresh(true);
    }
  }

  /** Cancel (not just reset) on page teardown: the gateway keeps a running
   * WizardSession and rejects future wizard.start calls until cancelled. */
  cancelOnDisconnect(): void {
    void this.controller.cancel();
  }

  answer(value: unknown): void {
    void this.controller.answer(value);
  }

  toggleMultiselect(value: unknown): void {
    this.multiselect = this.multiselect.includes(value)
      ? this.multiselect.filter((entry) => entry !== value)
      : [...this.multiselect, value];
    this.deps.requestUpdate();
  }

  private handleControllerChange(): void {
    // Pending multiselect toggles survive busy re-renders but reset per step.
    const wizard = this.controller.state;
    const stepId = wizard.phase === "step" ? wizard.step.id : null;
    if (stepId !== this.multiselectStepId) {
      this.multiselectStepId = stepId;
      this.multiselect =
        wizard.phase === "step" && Array.isArray(wizard.step.initialValue)
          ? [...wizard.step.initialValue]
          : [];
    }
    if (wizard.phase === "done" && this.lastPhase !== "done") {
      void this.handleCompleted(wizard.accounts);
    }
    this.lastPhase = wizard.phase;
    this.deps.requestUpdate();
  }

  private async handleCompleted(
    accounts: ReadonlyArray<{ channel: string; accountId: string }>,
  ): Promise<void> {
    const context = this.deps.getContext();
    if (!context) {
      return;
    }
    // The wizard rewrote openclaw.json on the gateway; resync the local draft.
    await context.runtimeConfig.refresh({ discardPendingChanges: true });
    await context.channels.refresh(true);
    const whatsapp = accounts.find((entry) => entry.channel === "whatsapp");
    if (whatsapp) {
      // Jump straight into QR pairing for the account the wizard configured;
      // the wizard modal renders the QR phase.
      this.whatsappAccountId = whatsapp.accountId;
      await context.channels.startWhatsApp(false, whatsapp.accountId);
    }
  }
}
