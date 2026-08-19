import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";

export function askCustodianAlert(
  alert: CustodianAlert | null,
  askedIds: Set<string>,
  ready: boolean,
  send: (question: string) => void,
): void {
  if (!alert || askedIds.has(alert.id) || !ready) {
    return;
  }
  askedIds.add(alert.id);
  send(alert.question);
}
