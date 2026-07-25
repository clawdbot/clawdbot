/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./custodian-page.ts";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  newAgentIntent: boolean;
  updateComplete: Promise<boolean>;
};

function createContext(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.chat"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const setSessionKey = vi.fn();
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "ws://gateway.test/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    setSessionKey,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  const refreshList = vi.fn().mockResolvedValue({
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main" }, { id: "researcher" }],
  });
  const context = {
    gateway,
    agents: { refreshList },
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return { context, refreshList, setSessionKey };
}

async function mountPage(context: ApplicationContext): Promise<TestCustodianPage> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  page.onboarding = false;
  page.newAgentIntent = true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

describe("custodian new-agent flow", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("requests the new-agent welcome variant", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "What should your new agent do?",
      action: "none",
    });
    const { context } = createContext(request);
    await mountPage(context);

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "new-agent" });
  });

  it("refreshes the roster and opens the created agent hatch session", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your agent is hatching.",
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
    const { context, refreshList, setSessionKey } = createContext(request);
    await mountPage(context);

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledOnce());
    expect(refreshList).toHaveBeenCalledOnce();
    expect(setSessionKey).toHaveBeenCalledWith("agent:researcher:main");
    expect(context.navigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Aresearcher%3Amain&draft=Wake%20up%2C%20my%20friend!",
    });
  });
});
