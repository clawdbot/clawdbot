/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";
import "./model-setup-page.ts";

type TestModelSetupPage = HTMLElement & {
  routeData?: ModelSetupRouteData;
  updateComplete: Promise<boolean>;
};

const recommendedIconUrl = "https://cdn.simpleicons.org/ollama";
const customIconUrl = "https://cdn.example.com/acme.png";

const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  recommendedInstalls: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Run open models locally",
      website: "https://ollama.com/download",
      icon: recommendedIconUrl,
    },
  ],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function createContext(): { context: ApplicationContext; client: GatewayBrowserClient } {
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: ["openclaw.setup.detect", "openclaw.setup.verify"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      token: "test-token",
      password: "",
      bootstrapToken: "",
    },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  return {
    client,
    context: {
      gateway,
      basePath: "/openclaw",
      navigate: vi.fn(),
    } as unknown as ApplicationContext,
  };
}

async function mountPage(
  context: ApplicationContext,
  routeData: ModelSetupRouteData,
): Promise<{ page: TestModelSetupPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("ModelSetupPage catalog icons", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses bundled brand icons without enqueueing their remote artwork", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    expect(
      page.querySelector('.model-setup__recommendation [data-provider-icon="ollama"]'),
    ).not.toBeNull();
    expect(page.querySelector(".model-setup__recommendation img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.innerHTML).not.toContain(recommendedIconUrl);
  });

  it("loads unknown wire icons through the authenticated same-origin catalog proxy", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi.fn(() => "blob:acme-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: [
            {
              id: "acme",
              label: "Acme",
              hint: "Install the Acme runtime",
              website: "https://example.com/acme",
              icon: customIconUrl,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:acme-icon");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(customIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.innerHTML).not.toContain(customIconUrl);

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:acme-icon");
  });

  it("keeps legacy known-provider artwork on the authenticated proxy path", async () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => "blob:legacy-ollama");
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: detection.recommendedInstalls?.map(
            ({ brandId: _brandId, ...entry }) => entry,
          ),
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:legacy-ollama");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(recommendedIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.querySelector(".model-setup__recommendation [data-provider-icon]")).toBeNull();
  });
});
