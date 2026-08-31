import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeIdFromPath } from "../../app-routes.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import { isDefaultChatLanding, startModelSetupFirstRunRedirectAfterLocation } from "./first-run.ts";

const defaultLanding = { pathname: "/chat/main", search: "", hash: "" };

async function startRedirect(
  context: ApplicationContext<RouteId>,
  currentLocation = defaultLanding,
): Promise<() => void> {
  return startModelSetupFirstRunRedirectAfterLocation({
    context,
    enabled: true,
    history: { location: () => currentLocation, replace: () => undefined },
    initialLocationReady: Promise.resolve(defaultLanding),
  });
}

function createConnectedContext(
  options: {
    selectedId?: string | null;
    defaultAgentId?: string;
    modelConfigured?: boolean;
    includeModelConfigured?: boolean;
    admin?: boolean;
    advertised?: boolean;
  } = {},
) {
  const request = vi.fn();
  const replace = vi.fn();
  const sessionDefaults = {
    defaultAgentId: options.defaultAgentId ?? "main",
    ...(options.includeModelConfigured === false
      ? {}
      : { modelConfigured: options.modelConfigured ?? false }),
  };
  const snapshot = {
    phase: "connected" as const,
    client: { request },
    hello: {
      auth: {
        role: "operator",
        scopes: [options.admin === false ? "operator.read" : "operator.admin"],
      },
      features: { methods: options.advertised === false ? [] : ["openclaw.setup.detect"] },
      snapshot: { sessionDefaults },
    },
  };
  const context = {
    gateway: {
      snapshot,
      connection: {
        gatewayUrl: "wss://gateway.example",
        token: "gateway-auth-token",
        password: "",
        bootstrapToken: "",
      },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: options.selectedId === undefined ? "main" : options.selectedId },
    },
    replace,
  } as unknown as ApplicationContext<RouteId>;
  return { context, replace, request };
}

describe("model setup first-run redirect", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "durable-device-private-key-for-testing" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes default chat landings without accepting session deep links", () => {
    expect(isDefaultChatLanding({ pathname: "/", search: "", hash: "" }, "", routeIdFromPath)).toBe(
      true,
    );
    expect(
      isDefaultChatLanding({ pathname: "/chat", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(true);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "?session=agent%3Amain%3Amain", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat", search: "", hash: "#session=agent%3Amain%3Amain" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding({ pathname: "/chat/main", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(true);
    expect(
      isDefaultChatLanding({ pathname: "/chat/main/", search: "", hash: "" }, "", routeIdFromPath),
    ).toBe(true);
    expect(
      isDefaultChatLanding(
        { pathname: "/openclaw/chat/main", search: "", hash: "" },
        "/openclaw",
        routeIdFromPath,
      ),
    ).toBe(true);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat/research", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/chat/main/existing-session", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/dashboard/main", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
    expect(
      isDefaultChatLanding(
        { pathname: "/settings/appearance", search: "", hash: "" },
        "",
        routeIdFromPath,
      ),
    ).toBe(false);
  });

  it("installs a released session deep link without registering the first-run gate", async () => {
    const releasedLocation = {
      pathname: "/chat",
      search: "?session=agent%3Aresearch%3Atelegram%3A12345",
      hash: "",
    };
    const canonicalLocation = {
      pathname: "/chat/research/telegram/12345",
      search: "",
      hash: "",
    };
    let currentLocation = releasedLocation;
    const replaceLocation = vi.fn((location: typeof releasedLocation) => {
      currentLocation = location;
    });
    const subscribe = vi.fn(() => () => undefined);
    const replaceRoute = vi.fn();
    const context = {
      gateway: { snapshot: {}, subscribe },
      replace: replaceRoute,
    } as unknown as ApplicationContext<RouteId>;

    await startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: isDefaultChatLanding(releasedLocation, "", routeIdFromPath),
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady: Promise.resolve(canonicalLocation),
    });

    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(subscribe).not.toHaveBeenCalled();
    expect(replaceRoute).not.toHaveBeenCalled();
  });

  it("redirects a restored default chat when no model has been configured", async () => {
    const { context, replace } = createConnectedContext();

    const dispose = await startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: isDefaultChatLanding(defaultLanding, "", routeIdFromPath),
      history: { location: () => defaultLanding, replace: () => undefined },
      initialLocationReady: Promise.resolve(defaultLanding),
    });

    expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    dispose();
  });

  it.each([
    {
      name: "the default agent has no configured model",
      options: {},
      shouldRedirect: true,
    },
    {
      name: "agent selection is unset",
      options: { selectedId: null },
      shouldRedirect: true,
    },
    {
      name: "the selected agent is the custom default",
      options: { selectedId: "research", defaultAgentId: "research" },
      shouldRedirect: true,
    },
    {
      name: "the default agent already has a configured model",
      options: { modelConfigured: true },
      shouldRedirect: false,
    },
    {
      name: "a non-default agent is explicitly selected",
      options: { selectedId: "research" },
      shouldRedirect: false,
    },
    {
      name: "the operator lacks admin access",
      options: { admin: false },
      shouldRedirect: false,
    },
    {
      name: "the setup method is not advertised",
      options: { advertised: false },
      shouldRedirect: false,
    },
    {
      name: "the handshake omits the model fact",
      options: { includeModelConfigured: false },
      shouldRedirect: false,
    },
  ])("decides synchronously when $name", async ({ options, shouldRedirect }) => {
    const { context, replace, request } = createConnectedContext(options);

    const dispose = await startRedirect(context);

    expect(request).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(shouldRedirect ? 1 : 0);
    if (shouldRedirect) {
      expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    }
    dispose();
  });

  it("does not redirect after the operator leaves the default landing", async () => {
    const { context, replace, request } = createConnectedContext();

    const dispose = await startRedirect(context, {
      pathname: "/settings/appearance",
      search: "",
      hash: "",
    });

    expect(request).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    dispose();
  });

  it("restores unfinished onboarding after its activation already configured the model", async () => {
    const { context, replace } = createConnectedContext({ modelConfigured: true });
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });

    const dispose = await startRedirect(context);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    });
    dispose();
  });

  it("does not restore an activation owned by replaced Gateway credentials", async () => {
    const { context, replace } = createConnectedContext({ modelConfigured: true });
    persistFirstRunActivationReceipt(context, {
      kind: "openai-api-key",
      modelRef: "openai/expected",
    });
    context.gateway.connection.token = "different-owner-token";

    const dispose = await startRedirect(context);

    await vi.waitFor(() => {
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    });
    expect(replace).not.toHaveBeenCalled();
    dispose();
  });

  it.each(["reload-required", "stopped"] as const)(
    "settles the initial decision on a terminal %s snapshot",
    async (phase) => {
      const onInitialDecision = vi.fn();
      const context = {
        gateway: {
          snapshot: { phase, client: null, hello: null },
          subscribe: () => () => undefined,
        },
        agentSelection: { state: { selectedId: "main" } },
        replace: vi.fn(),
      } as unknown as ApplicationContext<RouteId>;

      const dispose = await startModelSetupFirstRunRedirectAfterLocation({
        context,
        enabled: true,
        history: { location: () => defaultLanding, replace: () => undefined },
        initialLocationReady: Promise.resolve(defaultLanding),
        onInitialDecision,
      });

      expect(onInitialDecision).toHaveBeenCalledOnce();
      dispose();
    },
  );
});
