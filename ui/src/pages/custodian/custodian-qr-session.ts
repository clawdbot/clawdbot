import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import { hasUnresolvedCustodianQuestion, type CustodianMessage } from "./transcript.ts";

const QR_POLL_INTERVAL_MS = 1_000;
type QrStep = Extract<WizardStep, { type: "qr" }>;
type CustodianQrSessionOwner = {
  messages: CustodianMessage[];
  dismissedQuestions: ReadonlySet<string>;
  answeredQuestions: ReadonlySet<string>;
  wizardInputPending: boolean;
  questionReplyUncertain: boolean;
  activeClient: GatewayBrowserClient | null;
  chatAvailable: boolean;
  sending: boolean;
  pollQrStep: (client: GatewayBrowserClient, stepId: string) => void;
};

export class CustodianQrSession {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly owner: CustodianQrSessionOwner,
    private readonly onChange: () => void,
  ) {}

  hasActive(messages = this.owner.messages): boolean {
    return messages.some((message) => message.step?.type === "qr");
  }

  hasUnresolved(state: CustodianQrSessionOwner): boolean {
    return (
      this.hasActive(state.messages) ||
      hasUnresolvedCustodianQuestion(
        state.messages,
        state.dismissedQuestions,
        state.answeredQuestions,
        state.wizardInputPending,
        state.questionReplyUncertain,
      )
    );
  }

  clear(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  clearForRequest(pollStepId: string | undefined): void {
    if (pollStepId === undefined) {
      this.clear();
    }
  }

  reset(messages = this.owner.messages): void {
    this.clear();
    for (const message of messages) {
      if (message.step?.type === "qr") {
        message.step.qrDataUrl = "";
        message.step = null;
      }
    }
  }

  reconcile(messages: CustodianMessage[], pollStepId: string | undefined, step: WizardStep | null) {
    const active = messages.findLast((message) => message.step?.type === "qr");
    const replaces =
      pollStepId !== undefined &&
      step?.type === "qr" &&
      step.id === pollStepId &&
      active?.step?.id === pollStepId;
    if (active?.step?.type === "qr") {
      active.step.qrDataUrl = "";
      active.step = replaces ? step : null;
    }
    return replaces ? step : null;
  }

  schedule(client: GatewayBrowserClient, step: QrStep): void {
    this.clear();
    if (step.expiresInMs !== undefined) {
      this.expiryTimer = setTimeout(() => this.expire(client, step), Math.max(0, step.expiresInMs));
    }
    this.schedulePoll(client, step);
  }

  private schedulePoll(client: GatewayBrowserClient, step: QrStep): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      const active = this.owner.messages.findLast((message) => message.step?.id === step.id)?.step;
      if (
        active?.type !== "qr" ||
        client !== this.owner.activeClient ||
        !this.owner.chatAvailable
      ) {
        return;
      }
      if (this.owner.sending) {
        this.schedulePoll(client, active);
        return;
      }
      this.owner.pollQrStep(client, active.id);
    }, QR_POLL_INTERVAL_MS);
  }

  private expire(client: GatewayBrowserClient, step: QrStep): void {
    this.expiryTimer = null;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const message = this.owner.messages.findLast((candidate) => candidate.step?.id === step.id);
    if (message?.step?.type !== "qr") {
      return;
    }
    message.step.qrDataUrl = "";
    message.step = null;
    this.onChange();
    if (client === this.owner.activeClient && this.owner.chatAvailable && !this.owner.sending) {
      this.owner.pollQrStep(client, step.id);
    }
  }
}
