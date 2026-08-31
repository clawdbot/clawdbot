import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
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

    runtime = bootstrapApplication({
      sessionPathBuilderReady: new Promise<void>(() => {}),
    });

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
