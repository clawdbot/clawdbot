/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "./context.ts";
import "./app-host.ts";

type AppLifecycleState = {
  loginToken: string;
  loginPassword: string;
  loginShowGatewayToken: boolean;
  loginShowGatewayPassword: boolean;
  disconnectedCallback: () => void;
  synchronizeGateway: (gateway: ApplicationGateway) => void;
};

type ShellInitializationState = {
  routeState: { routeId?: string };
  ensureAgentsList: (
    snapshot: { client: GatewayBrowserClient | null; connected: boolean },
    agents: ApplicationContext["agents"],
  ) => void;
  ensureRuntimeConfig: (
    snapshot: { client: GatewayBrowserClient | null; connected: boolean },
    runtimeConfig: ApplicationContext["runtimeConfig"],
  ) => void;
};

type ShellKeyboardState = {
  runtime: {
    context: ApplicationContext;
  };
  handleDocumentKeydown: (event: KeyboardEvent) => void;
};

type ShellEpochState = {
  navDrawerOpen: boolean;
  navDrawerTrigger: HTMLElement | null;
  lastWorkspaceLocation: { routeId: string; search: string } | null;
  activeSessionKey: string;
  commandPaletteTarget: unknown;
  agentsListClient: GatewayBrowserClient | null;
  agentsListSource: ApplicationContext["agents"] | null;
  sessionKeyClient: GatewayBrowserClient | null;
  runtimeConfigClient: GatewayBrowserClient | null;
  runtimeConfigSource: ApplicationContext["runtimeConfig"] | null;
  settingsPreloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  disconnectedCallback: () => void;
};

describe("OpenClaw app lifecycle", () => {
  it("hides revealed login credentials when the app connection epoch ends", () => {
    const app = document.createElement("openclaw-app") as unknown as AppLifecycleState;
    app.loginShowGatewayToken = true;
    app.loginShowGatewayPassword = true;

    app.disconnectedCallback();

    expect(app.loginShowGatewayToken).toBe(false);
    expect(app.loginShowGatewayPassword).toBe(false);
  });

  it("hides revealed login credentials when the Gateway source changes", () => {
    const app = document.createElement("openclaw-app") as unknown as AppLifecycleState;
    const snapshot = {
      client: null,
      connected: false,
      reconnecting: false,
      lastError: null,
      lastErrorCode: null,
    } as ApplicationGatewaySnapshot;
    const firstGateway = {
      snapshot,
      connection: { gatewayUrl: "ws://first.test", token: "first", password: "first-password" },
    } as ApplicationGateway;
    const secondGateway = {
      snapshot,
      connection: {
        gatewayUrl: "ws://second.test",
        token: "second",
        password: "second-password",
      },
    } as ApplicationGateway;
    app.synchronizeGateway(firstGateway);
    app.loginShowGatewayToken = true;
    app.loginShowGatewayPassword = true;

    app.synchronizeGateway(secondGateway);

    expect(app.loginShowGatewayToken).toBe(false);
    expect(app.loginShowGatewayPassword).toBe(false);
    expect(app.loginToken).toBe("second");
    expect(app.loginPassword).toBe("second-password");
  });
});

describe("OpenClaw shell source initialization", () => {
  it("clears retained presentation and source ownership when its context epoch ends", () => {
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellEpochState;
    const client = {} as GatewayBrowserClient;
    const agents = {} as ApplicationContext["agents"];
    const runtimeConfig = {} as ApplicationContext["runtimeConfig"];
    const trigger = document.createElement("button");
    shell.navDrawerOpen = true;
    shell.navDrawerTrigger = trigger;
    shell.lastWorkspaceLocation = { routeId: "overview", search: "?agent=old" };
    shell.activeSessionKey = "agent:old:main";
    shell.commandPaletteTarget = {};
    shell.agentsListClient = client;
    shell.agentsListSource = agents;
    shell.sessionKeyClient = client;
    shell.runtimeConfigClient = client;
    shell.runtimeConfigSource = runtimeConfig;
    shell.settingsPreloadTimers.set(
      trigger,
      globalThis.setTimeout(() => undefined, 60_000),
    );

    shell.disconnectedCallback();

    expect(shell.navDrawerOpen).toBe(false);
    expect(shell.navDrawerTrigger).toBeNull();
    expect(shell.lastWorkspaceLocation).toBeNull();
    expect(shell.activeSessionKey).toBe("");
    expect(shell.commandPaletteTarget).toBeUndefined();
    expect(shell.agentsListClient).toBeNull();
    expect(shell.agentsListSource).toBeNull();
    expect(shell.sessionKeyClient).toBeNull();
    expect(shell.runtimeConfigClient).toBeNull();
    expect(shell.runtimeConfigSource).toBeNull();
    expect(shell.settingsPreloadTimers.size).toBe(0);
  });

  it("initializes replacement capabilities even when the Gateway client is unchanged", () => {
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellInitializationState;
    shell.routeState = { routeId: "overview" };
    const client = {} as GatewayBrowserClient;
    const snapshot = { client, connected: true };
    const firstAgents = {
      state: { agentsList: null },
      ensureList: vi.fn(() => Promise.resolve(null)),
    } as unknown as ApplicationContext["agents"];
    const secondAgents = {
      state: { agentsList: null },
      ensureList: vi.fn(() => Promise.resolve(null)),
    } as unknown as ApplicationContext["agents"];
    const firstRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];
    const secondRuntimeConfig = {
      ensureLoaded: vi.fn(() => Promise.resolve()),
    } as unknown as ApplicationContext["runtimeConfig"];

    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, firstAgents);
    shell.ensureAgentsList(snapshot, secondAgents);
    shell.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    shell.ensureRuntimeConfig(snapshot, firstRuntimeConfig);
    shell.ensureRuntimeConfig(snapshot, secondRuntimeConfig);

    expect(firstAgents.ensureList).toHaveBeenCalledOnce();
    expect(secondAgents.ensureList).toHaveBeenCalledOnce();
    expect(firstRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(secondRuntimeConfig.ensureLoaded).toHaveBeenCalledOnce();
  });
});

describe("OpenClaw shell keyboard shortcuts", () => {
  it("opens Settings with Shift-Command-Comma", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: "<",
      code: "Comma",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("config", undefined);
  });

  it("leaves plain Command-Comma to the browser", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      metaKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
