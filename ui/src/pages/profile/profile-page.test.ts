/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../../packages/gateway-protocol/src/index.ts";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    runtimeConfig: { subscribe, state: {}, ensureLoaded: async () => undefined },
    gateway: {
      snapshot,
      connection: {
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe,
    },
    agents: { subscribe, ensureList: vi.fn(async () => null) },
    agentIdentity: { subscribe, ensure: vi.fn(async () => undefined) },
  } as unknown as ApplicationContext<RouteId>;
}

function createConnectedContext(
  request: GatewayBrowserClient["request"],
  selfUser: AuthenticatedUser | null = null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: { request } as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
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
    runtimeConfig: { subscribe, state: {}, ensureLoaded: async () => undefined },
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
    navigate: vi.fn(),
  } as unknown as ApplicationContext<RouteId>;
  return {
    context,
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, phase: connected ? "connected" : "reconnecting" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function stubProfileAvatarProcessing() {
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
}

function selectProfileAvatar(page: ParentNode) {
  const avatarInput = page.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(avatarInput, "files", {
    configurable: true,
    value: [new File(["avatar"], "avatar.png", { type: "image/png" })],
  });
  avatarInput.dispatchEvent(new Event("change", { bubbles: true }));
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

it.each([
  { id: "profile-1", emails: ["ada@example.test"], emailRows: 1, hint: "Refresh to retry" },
  { id: "profile-1", emails: [], emailRows: 1, hint: "Refresh to retry" },
  { id: "gateway-owner", emails: [], emailRows: 0, hint: "Cloudflare Access" },
])(
  "renders $id identity before Usage statistics with emails $emails",
  async ({ id, emails, emailRows, hint }) => {
    const profile: UserProfile = {
      id,
      displayName: "Ada",
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 2,
      emails,
      githubIdentity: null,
      hasAvatar: false,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "users.self") {
        return { profile };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: profile.id,
      email: profile.emails[0],
      name: profile.displayName ?? undefined,
    });
    const provider = createApplicationContextProvider(harness.context);
    const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
    provider.append(page);
    document.body.append(provider);
    await waitForFast(() =>
      expect(page.querySelector("#settings-profile-identity")).not.toBeNull(),
    );

    expect(request.mock.calls.map(([method]) => method)).toEqual(["users.self"]);
    const identity = page.querySelector("#settings-profile-identity");
    expect(identity?.textContent).toContain(hint);
    expect(
      [...(identity?.querySelectorAll(".settings-row__title") ?? [])].filter(
        (node) => node.textContent?.trim() === "Linked emails",
      ),
    ).toHaveLength(emailRows);
    const docsLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/concepts/user-model");
    expect(page.querySelector(".profile-stats")).toBeNull();
    expect(page.querySelector(".profile-heatmap")).toBeNull();
    const usageRow = page.querySelector<HTMLButtonElement>(".settings-row--nav");
    expect(usageRow?.textContent).toContain("Usage statistics");
    expect(
      page.querySelector("#settings-profile-identity")?.compareDocumentPosition(usageRow!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    usageRow?.click();
    expect(harness.context.navigate).toHaveBeenCalledWith("usage");
  },
);

it("loads and updates co-author consent separately from verified GitHub identity", async () => {
  const profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
    hasAvatar: false,
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.prefs.get") {
      expect(params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
      return { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } };
    }
    if (method === "users.prefs.set") {
      expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true } });
      return { status: "ok" };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  expect(request.mock.calls.map(([method]) => method)).toEqual(["users.self", "users.prefs.get"]);
  expect(page.querySelector(".identity-github-form")).toBeNull();
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  expect(toggle?.checked).toBe(false);

  toggle!.checked = true;
  toggle?.dispatchEvent(new Event("change", { bubbles: true }));

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
  );
  await waitForFast(() => expect(toggle?.checked).toBe(true));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "users.self",
    "users.prefs.get",
    "users.prefs.set",
  ]);
});

it("treats a malformed co-author preference as opted out", async () => {
  const profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
    hasAvatar: false,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.prefs.get") {
      // The preference API stores arbitrary JSON; a non-boolean row must not publish a trailer.
      return { status: "ok", entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: "not-a-boolean" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  await waitForFast(() => expect(toggle?.checked).toBe(false));
});

it("keeps co-author credit on until the person opts out", async () => {
  const profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: [],
    githubIdentity: {
      login: "octocat",
      profileUrl: "https://github.com/octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    },
    hasAvatar: false,
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.prefs.get") {
      // No stored row: the verified account is credited without an explicit opt-in.
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      expect(params).toEqual({ entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false } });
      return { status: "ok" };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    name: profile.displayName ?? undefined,
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(page.querySelector(".settings-account")).not.toBeNull());
  const toggle = page.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  await waitForFast(() => expect(toggle?.checked).toBe(true));

  toggle!.checked = false;
  toggle?.dispatchEvent(new Event("change", { bubbles: true }));

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1),
  );
  await waitForFast(() => expect(toggle?.checked).toBe(false));
});

it("renders a write-access note without calling users.self for read-only viewers", async () => {
  const request = vi.fn(async () => ({
    personal: {
      state: "disconnected",
      generation: null,
      account: null,
      accessExpiresAtMs: null,
      refreshState: "not_applicable",
      pending: null,
    },
    system: {
      source: "system-detected",
      credentialKind: "native",
      credentialState: "unavailable",
      account: null,
      gitAuthor: { name: null, email: null },
      evidence: "none",
      accessExpiresAtMs: null,
      refreshState: "not_applicable",
      oauthScopes: [],
      repositoryGrants: "unknown",
    },
  }));
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  harness.context.gateway.snapshot.hello = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: ["operator.read"] },
    features: { methods: ["users.self"] },
  } as ApplicationGatewaySnapshot["hello"];
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await page.updateComplete;
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(page.textContent).toContain("Profile editing requires operator.write access.");
  expect(page.querySelector(".identity-name-control")).toBeNull();
});

it("explains unavailable identity without profile RPCs for unidentified connections", async () => {
  const request = vi.fn();
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await page.updateComplete;
  await Promise.resolve();

  expect(request.mock.calls.some(([method]) => method === "users.self")).toBe(false);
  const identity = page.querySelector("#settings-profile-identity");
  expect(identity?.textContent).toContain("This connection has no personal profile");
  expect(identity?.textContent).toContain("Cloudflare Access, Tailscale Serve, or a trusted proxy");
  expect(
    page.querySelector('a[href="https://docs.openclaw.ai/concepts/user-model"]'),
  ).not.toBeNull();
  expect(page.querySelector(".identity-name-control")).toBeNull();
  expect(page.querySelector('input[type="file"]')).toBeNull();
  expect(page.querySelector(".profile-refresh")).toBeNull();
});

it("rerenders on connection transitions for unidentified connections", async () => {
  const request = vi.fn();
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await page.updateComplete;
  expect(page.querySelector(".profile-hero")).not.toBeNull();

  // With no @state change (selfUser stays null), the snapshot handler must
  // still invalidate the render branch that reads connected/client.
  harness.emitConnected(false);
  await page.updateComplete;
  expect(page.querySelector(".profile-hero")).toBeNull();

  harness.emitConnected(true);
  await page.updateComplete;
  expect(page.querySelector(".profile-hero")).not.toBeNull();
});

it("falls back to the text avatar when the hero image fails to load", async () => {
  const request = vi.fn();
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  const agentsState = harness.context.agents.state as unknown as {
    agentsList: {
      defaultId: string;
      agents: Array<{
        id: string;
        identity: { name: string; emoji: string; avatarUrl: string };
      }>;
    };
  };
  agentsState.agentsList = {
    defaultId: "main",
    agents: [
      {
        id: "main",
        identity: {
          name: "Molty",
          emoji: "🦞",
          avatarUrl: "data:image/png;base64,unloadable",
        },
      },
    ],
  };
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await page.updateComplete;
  const image = page.querySelector<HTMLImageElement>(".profile-hero__avatar-image");
  expect(image?.getAttribute("src")).toBe("data:image/png;base64,unloadable");
  expect(page.querySelector(".profile-hero__avatar-text")).toBeNull();

  image?.dispatchEvent(new Event("error"));
  await page.updateComplete;

  expect(page.querySelector(".profile-hero__avatar-image")).toBeNull();
  expect(page.querySelector(".profile-hero__avatar-text")?.textContent).toBe("🦞");
});

it("fetches a protected hero avatar with the current Control UI credential", async () => {
  const createObjectURL = vi.fn(() => "blob:hero-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["avatar"], { type: "image/svg+xml" }),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const harness = createConnectedContext(vi.fn() as GatewayBrowserClient["request"]);
  harness.context.gateway.connection.token = "profile-token";
  const agentsState = harness.context.agents.state as unknown as {
    agentsList: {
      defaultId: string;
      agents: Array<{
        id: string;
        identity: { name: string; emoji: string; avatarUrl: string };
      }>;
    };
  };
  agentsState.agentsList = {
    defaultId: "main",
    agents: [
      {
        id: "main",
        identity: { name: "Molty", emoji: "🦞", avatarUrl: "/avatar/main" },
      },
    ],
  };
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => {
    expect(fetchMock).toHaveBeenCalledWith("/avatar/main", {
      headers: { Authorization: "Bearer profile-token" },
      signal: expect.any(AbortSignal),
    });
    expect(
      page.querySelector<HTMLImageElement>(".profile-hero__avatar-image")?.getAttribute("src"),
    ).toBe("blob:hero-avatar");
  });

  page.remove();
  await waitForFast(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:hero-avatar"));
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
    githubIdentity: null,
    hasAvatar: false,
  };
  let identityRequests = 0;
  const request = vi.fn(async (method: string) => {
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

it("keeps identity refresh single-flight and allows retry after settlement", async () => {
  const profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test"],
    githubIdentity: null,
    hasAvatar: false,
  };
  let rejectIdentity: ((reason: Error) => void) | undefined;
  const firstIdentity = new Promise<never>((_resolve, reject) => {
    rejectIdentity = reject;
  });
  const request = vi.fn(async (method: string) => {
    if (method !== "users.self") {
      throw new Error(`unexpected method: ${method}`);
    }
    if (request.mock.calls.length === 1) {
      return await firstIdentity;
    }
    return { profile };
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: profile.id,
    email: profile.emails[0],
    name: profile.displayName ?? undefined,
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1),
  );
  await page.updateComplete;
  const refresh = page.querySelector<HTMLButtonElement>(".profile-refresh")!;
  expect(refresh.disabled).toBe(true);
  expect(refresh.textContent?.trim()).toBe(t("common.refreshing"));

  const pageWithIdentity = page as unknown as { loadIdentity: () => Promise<void> };
  await Promise.all([pageWithIdentity.loadIdentity(), pageWithIdentity.loadIdentity()]);
  expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(1);

  rejectIdentity?.(new Error("identity unavailable: OPENAI_API_KEY=sk-1234567890abcdef"));
  await waitForFast(() => expect(refresh.disabled).toBe(false));
  expect(refresh.textContent?.trim()).toBe(t("common.refresh"));
  expect(page.textContent).toContain("identity unavailable: OPENAI_API_KEY=sk-123...cdef");
  expect(page.textContent).not.toContain("sk-1234567890abcdef");

  refresh.click();
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(2),
  );
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe("Ada"),
  );
});

it("replaces an in-flight identity request after a same-client reconnect", async () => {
  const staleProfile: UserProfile = {
    id: "profile-1",
    displayName: "Stale identity",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test"],
    githubIdentity: null,
    hasAvatar: false,
  };
  const freshProfile = { ...staleProfile, displayName: "Fresh identity", updatedAt: 3 };
  let resolveStale: ((value: { profile: UserProfile }) => void) | undefined;
  let resolveFresh: ((value: { profile: UserProfile }) => void) | undefined;
  const staleRequest = new Promise<{ profile: UserProfile }>((resolve) => {
    resolveStale = resolve;
  });
  const freshRequest = new Promise<{ profile: UserProfile }>((resolve) => {
    resolveFresh = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method !== "users.self") {
      throw new Error(`unexpected method: ${method}`);
    }
    return await (request.mock.calls.length === 1 ? staleRequest : freshRequest);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: staleProfile.id,
    email: staleProfile.emails[0],
    name: staleProfile.displayName ?? undefined,
  });
  const provider = createApplicationContextProvider(harness.context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);

  await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
  harness.emitConnected(false);
  await page.updateComplete;
  harness.emitConnected(true);
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

  resolveFresh?.({ profile: freshProfile });
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
      "Fresh identity",
    ),
  );
  resolveStale?.({ profile: staleProfile });
  await staleRequest;
  await Promise.resolve();
  await page.updateComplete;

  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Fresh identity",
  );
  expect(request).toHaveBeenCalledTimes(2);
});

it("bootstraps and refreshes the connected user's profile through users.self", async () => {
  let avatarRevision = "avatar-content-hash-png";
  let publishAvatarPresence: (() => void) | undefined;
  let profile: UserProfile = {
    id: "profile-1",
    displayName: "Ada",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 2,
    emails: ["ada@example.test", "ada@work.test"],
    githubIdentity: null,
    hasAvatar: false,
  };
  let omitNextProfile = false;
  const request = vi.fn(async (method: string, params?: unknown) => {
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
      publishAvatarPresence?.();
      return { profile, avatarRevision };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: "profile-1",
    email: "ada@example.test",
    name: "Ada",
  });
  publishAvatarPresence = () =>
    harness.context.gateway.updateSelfUser?.({
      avatarUrl: `/api/users/${profile.id}/avatar?v=${avatarRevision}`,
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
  stubProfileAvatarProcessing();
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(request.mock.calls.some(([method]) => method === "users.setAvatar")).toBe(true),
  );
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(3),
  );
  await page.updateComplete;
  expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
    `/api/users/profile-1/avatar?v=${avatarRevision}`,
  );
  expect(
    (
      page.querySelector("openclaw-viewer-avatar") as
        | (HTMLElement & { user?: AuthenticatedUser })
        | null
    )?.user?.avatarUrl,
  ).toBe(`/api/users/profile-1/avatar?v=${avatarRevision}`);
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    "Unsaved draft",
  );

  const avatarRequestCount = request.mock.calls.filter(
    ([method]) => method === "users.setAvatar",
  ).length;
  avatarRevision = "response-content-hash-png";
  publishAvatarPresence = undefined;
  selectProfileAvatar(page);
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "users.setAvatar")).toHaveLength(
      avatarRequestCount + 1,
    ),
  );
  await waitForFast(() =>
    expect(harness.context.gateway.snapshot.selfUser?.avatarUrl).toContain(
      `/api/users/profile-1/avatar?v=${avatarRevision}`,
    ),
  );
  await waitForFast(() =>
    expect(
      (
        page.querySelector("openclaw-viewer-avatar") as
          | (HTMLElement & { user?: AuthenticatedUser })
          | null
      )?.user?.avatarUrl,
    ).toContain(`/api/users/profile-1/avatar?v=${avatarRevision}`),
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
