import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";

type AlertListener = () => void;

class CustodianAlertStore {
  alert: CustodianAlert | null = null;

  // Shared by the page and panel singleton so observing both surfaces cannot ask twice.
  private readonly askedIds = new Set<string>();
  private readonly listeners = new Set<AlertListener>();

  subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  present(alert: CustodianAlert): void {
    this.alert = alert;
    this.emit();
  }

  dismiss(): void {
    this.alert = null;
    this.emit();
  }

  askIfReady(send: (question: string) => void): void {
    const alert = this.alert;
    if (!alert || this.askedIds.has(alert.id)) {
      return;
    }
    this.askedIds.add(alert.id);
    send(alert.question);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const custodianAlertStore = new CustodianAlertStore();
