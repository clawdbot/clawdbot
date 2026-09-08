import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import { startModelSetupFirstRunRedirectAfterLocation } from "../pages/model-setup/first-run.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadGatewaySessionSelection, loadSettings, saveSettings } from "./settings.ts";

it.each([
  { agentId: "main", savedAgentId: "work", basePath: "", suffix: "" },
  { agentId: "work", savedAgentId: "main", basePath: "", suffix: "" },
  { agentId: "main", savedAgentId: "work", basePath: "/openclaw", suffix: "/" },
  { agentId: "work", savedAgentId: "main", basePath: "/openclaw", suffix: "/" },
])(
  "keeps cold explicit $agentId over saved $savedAgentId at $basePath (suffix '$suffix')",
  async ({ agentId, savedAgentId, basePath, suffix }) => {
    const pathname = buildControlUiSessionPath({
      namespace: "chat",
      sessionKey: `agent:${agentId}:main`,
      exactKey: true,
      basePath,
    });
    expect(pathname).toBe(`${basePath}/chat/${agentId}`);
    const requested = { pathname: `${pathname}${suffix}`, search: "?draft=keep", hash: "#pane" };
    let currentLocation: RouteLocation = requested;
    const replace = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });
    const gateway = {
      snapshot: { phase: "connecting", client: null, hello: null },
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext<RouteId>["gateway"];
    const initialLocationReady = resolveInitialApplicationLocation({
      location: requested,
      basePath,
      sessionKey: `agent:${savedAgentId}:main`,
      selectedAgentId: savedAgentId,
      gateway,
      agentsList: () => null,
      signal: new AbortController().signal,
    });

    await startModelSetupFirstRunRedirectAfterLocation({
      context: { gateway } as ApplicationContext<RouteId>,
      enabled: false,
      history: { location: () => currentLocation, replace },
      initialLocationReady,
    });

    expect(currentLocation).toEqual(requested);
    expect(replace).not.toHaveBeenCalled();
    expect(gateway.subscribe).not.toHaveBeenCalled();
  },
);

it("routes a canonical global session through its persisted agent owner", async () => {
  const subscribe = vi.fn(() => () => undefined);

  await expect(
    resolveInitialApplicationLocation({
      location: { pathname: "/chat", search: "", hash: "" },
      basePath: "",
      sessionKey: "global",
      selectedAgentId: "openclaw",
      gateway: {
        snapshot: {
          phase: "connected",
          client: {},
          sessionKey: "global",
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "dummy",
                mainKey: "main",
                mainSessionKey: "global",
                scope: "global",
              },
            },
          },
        },
        subscribe,
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => ({
        defaultId: "dummy",
        mainKey: "main",
        scope: "global",
        agents: [
          { id: "dummy", kind: "agent" },
          { id: "openclaw", kind: "agent" },
        ],
      }),
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ pathname: "/chat/openclaw", search: "", hash: "" });
  expect(subscribe).not.toHaveBeenCalled();
});

it("falls back when the persisted agent is absent from the Gateway roster", async () => {
  await expect(
    resolveInitialApplicationLocation({
      location: { pathname: "/chat", search: "", hash: "" },
      basePath: "",
      sessionKey: "global",
      selectedAgentId: "removed",
      gateway: {
        snapshot: {
          phase: "connected",
          client: {},
          sessionKey: "global",
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "dummy",
                mainKey: "main",
                mainSessionKey: "global",
                scope: "global",
              },
            },
          },
        },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => ({
        defaultId: "dummy",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "dummy", kind: "agent" }],
      }),
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ pathname: "/chat/dummy", search: "", hash: "" });
});

it("replaces a confirmed-missing remembered session with the agent main route", async () => {
  const request = vi.fn(async () => ({ ok: false as const }));

  await expect(
    resolveInitialApplicationLocation({
      location: { pathname: "/", search: "?draft=hello", hash: "" },
      basePath: "",
      sessionKey: "agent:research:thread:12345678-0000-4000-8000-000000000001",
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request },
          hello: { snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } } },
        },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => ({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "research" }],
      }),
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ pathname: "/chat/research", search: "?draft=hello", hash: "" });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.resolve",
    {
      key: "agent:research:thread:12345678-0000-4000-8000-000000000001",
      agentId: "research",
      allowMissing: true,
    },
    { signal: expect.any(AbortSignal) },
  );
});

it("refreshes a cached roster and its default before accepting a remembered agent", async () => {
  const cachedList: AgentsListResult = {
    defaultId: "retired",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "retired" }],
  };
  const liveList: AgentsListResult = {
    ...cachedList,
    defaultId: "next",
    agents: [{ id: "next" }],
  };
  const ensureAgentsList = vi.fn(async () => liveList);

  await expect(
    resolveInitialApplicationLocation({
      location: { pathname: "/", search: "", hash: "" },
      basePath: "",
      sessionKey: "agent:retired:main",
      gateway: {
        snapshot: {
          phase: "connected",
          client: { request: vi.fn() },
          hello: { snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } } },
        },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => cachedList,
      ensureAgentsList,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ pathname: "/chat/next", search: "", hash: "" });
  expect(ensureAgentsList).toHaveBeenCalledOnce();
});

it("validates a remembered session again after the Gateway client changes", async () => {
  let finishFirstRequest:
    | ((result: { ok: true; key: string; agentId: string }) => void)
    | undefined;
  const firstRequest = vi.fn(
    (): Promise<{ ok: boolean; key?: string; agentId?: string }> =>
      new Promise((resolve) => {
        finishFirstRequest = resolve;
      }),
  );
  const replacementRequest = vi.fn(
    async (): Promise<{ ok: boolean; key?: string; agentId?: string }> => ({ ok: false }),
  );
  const firstHello = {
    snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } },
  };
  const replacementHello = {
    snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } },
  };
  const gatewayState = {
    snapshot: {
      phase: "connected",
      client: { request: firstRequest },
      hello: firstHello,
    },
    subscribe: vi.fn(() => () => undefined),
  };
  const gateway = gatewayState as unknown as ApplicationContext<RouteId>["gateway"];
  const rememberedKey = "agent:research:thread:12345678-0000-4000-8000-000000000001";

  const pending = resolveInitialApplicationLocation({
    location: { pathname: "/", search: "", hash: "" },
    basePath: "",
    sessionKey: rememberedKey,
    gateway,
    agentsList: () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "research" }],
    }),
    signal: new AbortController().signal,
  });
  await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce());
  gatewayState.snapshot = {
    ...gatewayState.snapshot,
    client: { request: replacementRequest },
    hello: replacementHello,
  };
  finishFirstRequest?.({ ok: true, key: rememberedKey, agentId: "research" });

  await expect(pending).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
  expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
    "sessions.resolve",
    { key: rememberedKey, agentId: "research", allowMissing: true },
    { signal: expect.any(AbortSignal) },
  );
});

it("loads the agent roster again after the Gateway client changes", async () => {
  let finishFirstList: ((result: AgentsListResult) => void) | undefined;
  const currentList: AgentsListResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }],
  };
  const oldList = { ...currentList, agents: [{ id: "main" }, { id: "research" }] };
  const ensureAgentsList = vi
    .fn<() => Promise<AgentsListResult>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstList = resolve;
        }),
    )
    .mockResolvedValue(currentList);
  const gatewayState = {
    snapshot: {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } } },
    },
    subscribe: vi.fn(() => () => undefined),
  };
  const gateway = gatewayState as unknown as ApplicationContext<RouteId>["gateway"];

  const pending = resolveInitialApplicationLocation({
    location: { pathname: "/", search: "", hash: "" },
    basePath: "",
    sessionKey: "agent:research:main",
    gateway,
    agentsList: () => null,
    ensureAgentsList,
    signal: new AbortController().signal,
  });
  await vi.waitFor(() => expect(ensureAgentsList).toHaveBeenCalledOnce());
  gatewayState.snapshot = {
    ...gatewayState.snapshot,
    client: {},
    hello: { snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main" } } },
  };
  finishFirstList?.(oldList);

  await expect(pending).resolves.toEqual({ pathname: "/chat/main", search: "", hash: "" });
  expect(ensureAgentsList).toHaveBeenCalledTimes(2);
});

it("starts routing an agent-scoped remembered session while the Gateway is offline", async () => {
  const previousSettings = loadSettings();
  const previousUrl = window.location.href;
  saveSettings({
    ...previousSettings,
    sessionKey: "agent:research:thread:12345678-0000-4000-8000-000000000001",
    lastActiveSessionKey: "agent:research:thread:12345678-0000-4000-8000-000000000001",
  });
  window.history.replaceState({}, "", "/");
  const runtime = bootstrapApplication();
  const routerStart = vi.spyOn(runtime.router, "start").mockResolvedValue(undefined);

  try {
    const start = runtime.start();
    await vi.waitFor(() => expect(routerStart).toHaveBeenCalledOnce());
    runtime.stop();
    await start;
  } finally {
    runtime.stop();
    saveSettings(previousSettings);
    window.history.replaceState({}, "", previousUrl);
  }
});

it.each([
  { name: "saved target agent", selectedAgentId: "research" },
  { name: "unsaved target agent", selectedAgentId: undefined },
])("hydrates the $name during native Gateway handoff", ({ selectedAgentId }) => {
  const previousSettings = loadSettings();
  const previousUrl = window.location.href;
  const targetGatewayUrl = `wss://native-${selectedAgentId ?? "unset"}.example`;
  const targetSettingsKey = `openclaw.control.settings.v1:${gatewayOriginScope(targetGatewayUrl)}`;
  let runtime: ReturnType<typeof bootstrapApplication> | undefined;

  try {
    saveSettings({
      ...previousSettings,
      gatewayUrl: targetGatewayUrl,
      sessionKey: "global",
      lastActiveSessionKey: "global",
      selectedAgentId,
    });
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:dummy:main",
      lastActiveSessionKey: "agent:dummy:main",
      selectedAgentId: "dummy",
    });
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: targetGatewayUrl,
      token: "native-token",
    };
    window.history.replaceState({}, "", "/settings/appearance");

    runtime = bootstrapApplication();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(targetGatewayUrl);
    expect(runtime.context.gateway.snapshot.sessionKey).toBe("global");
    expect(loadGatewaySessionSelection(targetGatewayUrl)).toEqual({
      sessionKey: "global",
      lastActiveSessionKey: "global",
      ...(selectedAgentId ? { selectedAgentId } : {}),
    });
  } finally {
    runtime?.stop();
    delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    localStorage.removeItem(targetSettingsKey);
    window.history.replaceState({}, "", previousUrl);
    saveSettings(previousSettings);
  }
});
