/* @vitest-environment jsdom */

import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import "./custodian-page.ts";
import { renderCustodianRoute } from "./route-view.ts";
import { page, type CustodianRouteData } from "./route.ts";

function location(search: string): RouteLocation {
  return { pathname: "/custodian", search, hash: "" };
}

function loadRoute(search: string): CustodianRouteData {
  if (!page.loader) {
    throw new Error("custodian route has no loader");
  }
  return page.loader({} as ApplicationContext, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: location(search),
    deps: search,
    cause: "navigation",
  } satisfies RouteLoaderOptions) as CustodianRouteData;
}

function createContext(): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "ws://gateway.test/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  return { gateway } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("custodian route", () => {
  it("keys and resolves route data from onboarding search", () => {
    const context = {} as ApplicationContext;
    expect(page.loaderDeps?.(context, location(""))).toBe("");
    expect(loadRoute("")).toEqual({ onboarding: false, intent: null });
    expect(loadRoute("?onboarding=1")).toEqual({ onboarding: true, intent: null });
    expect(loadRoute("?intent=new-agent")).toEqual({ onboarding: false, intent: "new-agent" });
  });

  it("renders mode-specific framing", async () => {
    const provider = createApplicationContextProvider(createContext());
    document.body.append(provider);

    render(renderCustodianRoute({ onboarding: false, intent: null }), provider);
    const normalPage = provider.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-page",
    );
    await normalPage?.updateComplete;
    expect(normalPage?.querySelector(".custodian__header .btn")).toBeNull();
    expect(normalPage?.querySelector(".custodian__header p")?.textContent?.trim()).toBe(
      "System setup and care.",
    );

    render(renderCustodianRoute({ onboarding: true, intent: null }), provider);
    const onboardingPage = provider.querySelector<
      HTMLElement & { updateComplete: Promise<boolean> }
    >("openclaw-custodian-page");
    await onboardingPage?.updateComplete;
    expect(onboardingPage?.querySelector(".custodian__header .btn")).not.toBeNull();
    expect(onboardingPage?.querySelector(".custodian__header p")?.textContent?.trim()).toBe(
      "Your system setup guide",
    );
  });
});
