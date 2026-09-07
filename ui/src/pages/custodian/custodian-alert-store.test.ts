/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-surface.ts";

function alert(id: string): CustodianAlert {
  return {
    id,
    title: "1 automation failed",
    facts: ["Nightly backup: disk full"],
    question: "Why did Nightly backup fail?",
  };
}

afterEach(() => {
  custodianAlertStore.dismiss();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CustodianAlertStore", () => {
  it("asks once per presentation so both surfaces cannot double-send", () => {
    const send = vi.fn();
    const incident = alert("ask-once");

    custodianAlertStore.present(incident);
    custodianAlertStore.askIfReady(send);
    custodianAlertStore.askIfReady(send);

    expect(send).toHaveBeenCalledExactlyOnceWith(incident.question);
  });

  // A failed automation keeps one incident id across recover-then-fail-again;
  // an id-keyed dedupe would show the renewed alert and never explain it.
  it("re-arms the explanation when the same incident is presented again", () => {
    const send = vi.fn();
    const incident = alert("recurring-incident");

    custodianAlertStore.present(incident);
    custodianAlertStore.askIfReady(send);
    custodianAlertStore.dismiss();
    custodianAlertStore.present(incident);
    custodianAlertStore.askIfReady(send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("presents, emits, and dismisses an alert", () => {
    const listener = vi.fn();
    const incident = alert("present-dismiss");
    const unsubscribe = custodianAlertStore.subscribe(listener);

    custodianAlertStore.present(incident);
    expect(custodianAlertStore.alert).toBe(incident);
    expect(listener).toHaveBeenCalledOnce();

    custodianAlertStore.dismiss();
    expect(custodianAlertStore.alert).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("retires scoped facts and a queued question when its owner loses authority", () => {
    let current = true;
    const admit = vi.fn(() => true);
    const send = vi.fn();
    custodianAlertStore.present(alert("scoped"), { isCurrent: () => current, admit });
    current = false;

    custodianAlertStore.askIfReady(send);

    expect(custodianAlertStore.alert).toBeNull();
    expect(admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("renders without sending when custodian chat is unavailable", async () => {
    const request = vi.fn();
    const { context } = createContext(request, []);
    const provider = createApplicationContextProvider(context);
    const sessionStore = new CustodianSessionStore();
    const send = vi.spyOn(sessionStore, "send");
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = sessionStore;
    provider.append(surface);
    document.body.append(provider);

    custodianAlertStore.present(alert("chat-unavailable"));
    await surface.updateComplete;

    expect(send).not.toHaveBeenCalled();
    expect(surface.querySelector(".custodian__alert-card")?.textContent).toContain(
      "Nightly backup: disk full",
    );
  });
});
