/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RouteId } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { ProfilePage } from "./profile-page.ts";

const PROVIDER_ELEMENT_NAME = "test-profile-page-context-provider";
const PROFILE_PAGE_TEST_TAG = "test-openclaw-profile-page";

class ProfilePageContextProvider extends LitElement {
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });

  setContext(context: ApplicationContext<RouteId>) {
    this.contextProvider.setValue(context);
  }
}

if (!customElements.get(PROVIDER_ELEMENT_NAME)) {
  customElements.define(PROVIDER_ELEMENT_NAME, ProfilePageContextProvider);
}
// Keep the element class on the same post-reset i18n module as this test.
if (!customElements.get(PROFILE_PAGE_TEST_TAG)) {
  customElements.define(PROFILE_PAGE_TEST_TAG, class extends ProfilePage {});
}

type ProfilePageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

function createContext(): ApplicationContext<RouteId> {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: { subscribe },
    agentIdentity: { subscribe },
  } as unknown as ApplicationContext<RouteId>;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
});

it("refreshes translated copy when the locale changes while mounted", async () => {
  const provider = document.createElement(PROVIDER_ELEMENT_NAME) as ProfilePageContextProvider;
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.setContext(createContext());
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;

  const note = page.querySelector(".settings-empty");
  const englishNote = note?.textContent?.trim();

  await i18n.setLocale("de");
  await page.updateComplete;

  expect(note?.textContent?.trim()).toBe(t("profilePage.offline"));
  expect(note?.textContent?.trim()).not.toBe(englishNote);
});
