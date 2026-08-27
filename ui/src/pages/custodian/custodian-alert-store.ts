import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";

type AlertListener = () => void;

class CustodianAlertStore {
  alert: CustodianAlert | null = null;

  // Ask-once is scoped to the current presentation, not to the alert id forever.
  // A failed automation keeps one incident id across recover-then-fail-again, so
  // a permanent id set would silently swallow the explanation every later time
  // the same job breaks. Presenting is user-initiated, so re-arming here cannot
  // spam turns, and both observing surfaces still share the one flag.
  private askedPresented = false;
  private readonly listeners = new Set<AlertListener>();

  subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  present(alert: CustodianAlert): void {
    this.alert = alert;
    this.askedPresented = false;
    this.emit();
  }

  dismiss(): void {
    this.alert = null;
    this.emit();
  }

  askIfReady(send: (question: string) => void): void {
    const alert = this.alert;
    if (!alert || this.askedPresented) {
      return;
    }
    this.askedPresented = true;
    send(alert.question);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const custodianAlertStore = new CustodianAlertStore();
