/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CostUsageSummary, SessionsUsageResult } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { USAGE_PAYLOAD_TTL_MS, type UsageRefreshReason } from "../usage/refresh-policy.ts";
import { ProfilePage } from "./profile-page.ts";

const PROFILE_PAGE_TEST_TAG = "test-openclaw-profile-page";
// Keep the element class on the same post-reset i18n module as this test.
if (!customElements.get(PROFILE_PAGE_TEST_TAG)) {
  customElements.define(PROFILE_PAGE_TEST_TAG, class extends ProfilePage {});
}

type ProfilePageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

function createContext(
  client: GatewayBrowserClient | null = null,
  connected = false,
): ApplicationContext<RouteId> {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
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
    agents: { subscribe, ensureList: vi.fn(async () => null) },
    agentIdentity: { subscribe, ensure: vi.fn(async () => undefined) },
  } as unknown as ApplicationContext<RouteId>;
}

function createCostSummary(cacheStatus?: CostUsageSummary["cacheStatus"]): CostUsageSummary {
  return {
    updatedAt: 0,
    days: 0,
    daily: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 1,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

function createSessionsResult(): SessionsUsageResult {
  const totals = createCostSummary().totals;
  return {
    updatedAt: 0,
    startDate: "2026-07-08",
    endDate: "2026-07-08",
    sessions: [],
    totals,
    aggregates: {
      messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [],
    },
  };
}

function createConnectedContext(
  request: GatewayBrowserClient["request"],
  selfUser: AuthenticatedUser | null = null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: { request } as GatewayBrowserClient,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const subscribe = () => () => undefined;
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      connection: {
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      updateSelfUser(patch: Partial<Omit<AuthenticatedUser, "id">>) {
        if (!snapshot.selfUser) {
          return;
        }
        snapshot = { ...snapshot, selfUser: { ...snapshot.selfUser, ...patch } };
        for (const listener of listeners) {
          listener(snapshot);
        }
      },
    },
    agents: {
      state: { agentsList: null },
      ensureList: async () => null,
      subscribe,
    },
    agentIdentity: {
      get: () => null,
      ensure: async () => undefined,
      subscribe,
    },
    config: {
      current: {
        assistantIdentity: {
          name: "OpenClaw",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
      },
      subscribe,
    },
    basePath: "",
  } as unknown as ApplicationContext<RouteId>;
  return {
    context,
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it("refreshes translated copy when the locale changes while mounted", async () => {
  const provider = createApplicationContextProvider(createContext());
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
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

it("gates profile usage refreshes by payload age and page visibility", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const request = vi.fn(async (method: string) => {
    if (method === "usage.cost") {
      return createCostSummary();
    }
    return createSessionsResult();
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement & {
    costSummary: CostUsageSummary | null;
    lastProfileLoadedAtMs: number | null;
    loading: boolean;
    requestProfileRefresh: (reason: UsageRefreshReason) => void;
    scheduleCacheSettleRefresh: () => void;
  };
  provider.append(page);
  document.body.append(provider);
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
  await waitForFast(() => expect(page.loading).toBe(false));

  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);

  let reconnectPollDelayMs: number | undefined;
  const reconnectTimerSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
    _handler: TimerHandler,
    timeout?: number,
  ) => {
    reconnectPollDelayMs = Number(timeout);
    return 1;
  }) as unknown as typeof window.setTimeout);
  page.costSummary = createCostSummary({
    status: "refreshing",
    cachedFiles: 0,
    pendingFiles: 1,
    staleFiles: 0,
  });
  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(reconnectPollDelayMs).toBeGreaterThan(0);
  expect(reconnectPollDelayMs).toBeLessThanOrEqual(USAGE_PAYLOAD_TTL_MS);
  reconnectTimerSpy.mockRestore();

  page.lastProfileLoadedAtMs = Date.now() - USAGE_PAYLOAD_TTL_MS;
  visibility.mockReturnValue("hidden");
  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).toHaveBeenCalledTimes(2);

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
  await waitForFast(() => expect(page.loading).toBe(false));

  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));
  await waitForFast(() => expect(page.loading).toBe(false));

  let settlePoll: TimerHandler | null = null;
  let settleDelayMs: number | undefined;
  const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
  ) => {
    settlePoll = handler;
    settleDelayMs = Number(timeout);
    return 1;
  }) as unknown as typeof window.setTimeout);
  page.costSummary = createCostSummary({
    status: "refreshing",
    cachedFiles: 0,
    pendingFiles: 1,
    staleFiles: 0,
  });
  const nowMs = Date.now();
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  page.lastProfileLoadedAtMs = nowMs;
  page.scheduleCacheSettleRefresh();
  expect(settleDelayMs).toBe(USAGE_PAYLOAD_TTL_MS);
  nowSpy.mockRestore();

  page.lastProfileLoadedAtMs = Date.now() - USAGE_PAYLOAD_TTL_MS;
  visibility.mockReturnValue("hidden");
  (settlePoll as (() => void) | null)?.();
  expect(request).toHaveBeenCalledTimes(6);

  setTimeoutSpy.mockRestore();
  visibility.mockReturnValue("visible");
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(8));
});

it("keeps identity UI and profile RPCs absent for unidentified connections", async () => {
  const request = vi.fn(async (method: string) =>
    method === "usage.cost" ? createCostSummary() : createSessionsResult(),
  );
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await page.updateComplete;
  await Promise.resolve();

  expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(false);
  expect(page.querySelector("#settings-profile-identity")).toBeNull();
});

it("retries the identity bootstrap when users.self returns no profile", async () => {
  const profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test"],
    hasAvatar: false,
  };
  let identityRequests = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "usage.cost") {
      return createCostSummary();
    }
    if (method === "sessions.usage") {
      return createSessionsResult();
    }
    if (method === "users.self") {
      identityRequests += 1;
      return identityRequests === 1 ? {} : { profile };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(page.querySelector(".profile-identity-empty")).not.toBeNull());
  const emptyState = page.querySelector<HTMLElement>(".profile-identity-empty");
  const setIdentityButton = emptyState?.querySelector<HTMLButtonElement>("button");
  expect(emptyState?.textContent).toContain(t("profilePage.identity.notSet"));
  expect(setIdentityButton?.textContent?.trim()).toBe(t("profilePage.identity.setIdentity"));
  expect(page.textContent).not.toContain("Cannot read properties of undefined");

  setIdentityButton?.click();

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Ada"),
  );
});

it("bootstraps and refreshes the connected user's profile through users.self", async () => {
  let profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test", "ada@work.test"],
    hasAvatar: false,
  };
  let omitNextProfile = false;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "usage.cost") {
      return createCostSummary();
    }
    if (method === "sessions.usage") {
      return createSessionsResult();
    }
    if (method === "users.self") {
      if (omitNextProfile) {
        omitNextProfile = false;
        return {};
      }
      return { profile };
    }
    if (method === "users.setDisplayName") {
      expect(params).toEqual({ profileId: "profile-1", displayName: "Augusta Ada" });
      profile = { ...profile, displayName: "Augusta Ada", updatedAt: 3 };
      return { profile };
    }
    if (method === "users.setAvatar") {
      profile = {
        ...profile,
        displayName: "Augusta Ada",
        avatarMime: "image/png",
        hasAvatar: true,
        updatedAt: 4,
      };
      return { profile };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(page.querySelector("#settings-profile-identity")).not.toBeNull());
  const identityState = page as unknown as {
    selfUser: AuthenticatedUser | null;
    ownProfile: UserProfile | null;
  };
  expect(identityState.selfUser?.id).toBe(profile.id);
  expect(identityState.ownProfile?.id).toBe(profile.id);
  expect(page.textContent).toContain("ada@example.test, ada@work.test");
  expect(request.mock.calls.some(([method]) => method === "users.list")).toBe(false);

  const input = page.querySelector<HTMLInputElement>('.identity-name-control input[type="text"]');
  input!.value = "Augusta Ada";
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>('.identity-name-control button[type="submit"]')?.click();

  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.setDisplayName")).toBe(true),
  );
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  await page.updateComplete;
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Augusta Ada",
  );
  expect(harness.context.gateway.snapshot.selfUser?.name).toBe("Augusta Ada");

  const displayNameInput = page.querySelector<HTMLInputElement>(".identity-name-control input")!;
  displayNameInput.value = "Unsaved draft";
  displayNameInput.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  class StubUrl extends URL {
    static override createObjectURL = vi.fn(() => "blob:avatar");
    static override revokeObjectURL = vi.fn();
  }
  class StubImage {
    decoding = "auto";
    src = "";
    naturalWidth = 512;
    naturalHeight = 256;
    decode = vi.fn(async () => undefined);
  }
  vi.stubGlobal("URL", StubUrl);
  vi.stubGlobal("Image", StubImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: type ?? "image/png" }));
  });
  const avatarInput = page.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(avatarInput, "files", {
    configurable: true,
    value: [new File(["avatar"], "avatar.png", { type: "image/png" })],
  });
  avatarInput.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.setAvatar")).toBe(true),
  );
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(3),
  );
  await page.updateComplete;
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
    "/api/users/profile-1/avatar?v=4",
  );
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Unsaved draft",
  );

  omitNextProfile = true;
  request.mockClear();
  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(true),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(
      false,
    ),
  );
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Unsaved draft",
  );
  expect(page.querySelector(".profile-identity-empty")).toBeNull();

  const pageWithState = page as ProfilePageElement & {
    identityBusy: "display-name" | "avatar" | null;
  };
  pageWithState.identityBusy = "avatar";
  request.mockClear();
  page.querySelector<HTMLButtonElement>(".profile-refresh")?.click();
  await Promise.resolve();
  expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(false);
});
