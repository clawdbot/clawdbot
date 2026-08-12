/* @vitest-environment jsdom */

import type { PortalListResult, PortalSummary } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolvePortalUrl } from "./portal-url.ts";
import "./portals-page.ts";

type PortalsPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

const portal: PortalSummary = {
  id: "p3000",
  title: "Seeded app",
  port: 3000,
  listenPort: 43_123,
  tokenQuery: "openclaw_portal=secret-token",
  url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
  publicUrl: "http://127.0.0.1:43123/app",
  path: "/app",
  description: "Use the seeded test account.",
  createdAtMs: 1_000,
};

function createContext(
  methods: string[],
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const requestMock = vi.fn(request);
  const client = { request: requestMock } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: { features: { methods } } as ApplicationGatewaySnapshot["hello"],
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "wss://gateway.example.test:18789/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    context: { gateway } as unknown as ApplicationContext,
    emitPortals(portals: PortalSummary[]) {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "portal.changed", payload: { portals } });
      }
    },
    request: requestMock,
  };
}

async function mountPage(context: ApplicationContext) {
  const page = document.createElement("openclaw-portals-page") as PortalsPageTestElement;
  page.context = context;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("PortalsPage", () => {
  it("renders the portal list and applies full replacement events", async () => {
    const source = createContext(["portal.list", "portal.close"], async (method) => {
      if (method === "portal.list") {
        return { portals: [portal] } satisfies PortalListResult;
      }
      return { closed: true };
    });
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
    });
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain("Port 3000");
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain(
      "Use the seeded test account.",
    );
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      "https://gateway.example.test:43123/app?openclaw_portal=secret-token",
    );
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );

    source.emitPortals([]);

    await vi.waitFor(() => {
      expect(page.querySelector(".portals-rail__item")).toBeNull();
      expect(page.textContent).toContain("Ask the agent to start a portal:");
    });
  });

  it("shows the empty prompts and an unsupported note without calling the method", async () => {
    const source = createContext([], async () => ({ portals: [] }));
    const page = await mountPage(source.context);

    expect(page.textContent).toContain("Ask the agent to start a portal:");
    expect(page.textContent).toContain("Show me in a portal.");
    expect(page.textContent).toContain("Start the application in a portal.");
    expect(page.textContent).toContain("Make the server available in a portal.");
    expect(page.textContent).toContain("This gateway does not support portals.");
    expect(source.request).not.toHaveBeenCalled();
  });
});

describe("resolvePortalUrl", () => {
  it("uses the resolved gateway host and scheme with the portal listener port", () => {
    expect(
      resolvePortalUrl(
        portal,
        "wss://gateway.example.test:18789/control",
        "http://control-ui.example.test",
      ),
    ).toBe("https://gateway.example.test:43123/app?openclaw_portal=secret-token");
  });
});
