import type {
  CustodianAlert,
  CustodianTurnAdmission,
} from "../../components/custodian-alert-contract.ts";

type AlertListener = () => void;

class CustodianAlertStore {
  private presentedAlert: CustodianAlert | null = null;
  private admission: CustodianTurnAdmission | undefined;

  get alert(): CustodianAlert | null {
    return this.admission?.isCurrent() === false ? null : this.presentedAlert;
  }

  // Ask-once is scoped to the current presentation, not to the alert id forever.
  // A failed automation keeps one incident id across recover-then-fail-again, so
  // a permanent id set would silently swallow the explanation every later time
  // the same job breaks. Automatic presentations have their own admission
  // owner, and both observing surfaces still share this one flag.
  private askedPresented = false;
  private readonly listeners = new Set<AlertListener>();

  subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  present(alert: CustodianAlert, admission?: CustodianTurnAdmission): void {
    this.presentedAlert = alert;
    this.admission = admission;
    this.askedPresented = false;
    this.emit();
  }

  dismiss(): void {
    this.presentedAlert = null;
    this.admission = undefined;
    this.emit();
  }

  askIfReady(
    send: (question: string, admission?: CustodianTurnAdmission, display?: string) => void,
  ): void {
    const alert = this.alert;
    if (!alert || this.askedPresented) {
      return;
    }
    this.askedPresented = true;
    if (this.admission) {
      // Automatic diagnostics keep their detailed facts in the scoped card.
      send(alert.question, this.admission, alert.title);
    } else {
      send(alert.question);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const custodianAlertStore = new CustodianAlertStore();
