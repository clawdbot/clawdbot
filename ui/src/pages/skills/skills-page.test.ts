/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { SkillsRouteData } from "./skills-page.ts";
import "./skills-page.ts";

type TestPage = HTMLElement & {
  context: ApplicationContext;
  routeData?: SkillsRouteData;
  skillsReport: SkillsRouteData["report"];
  clawhubVerdicts: Record<string, unknown>;
  clawhubVerdictsLoading: boolean;
  clawhubVerdictsError: string | null;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

function gatewayWithClient(
  client: GatewayBrowserClient,
  connected: boolean,
): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

function contextWithClient(
  client: GatewayBrowserClient,
  options: { connected?: boolean; agentsList?: unknown } = {},
): ApplicationContext {
  const subscribe = () => () => undefined;
  const agentsList = options.agentsList ?? null;
  return {
    basePath: "",
    gateway: gatewayWithClient(client, options.connected ?? false),
    agents: {
      state: { agentsList, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => agentsList),
      subscribe,
    },
    agentIdentity: { get: () => undefined, ensure: vi.fn(async () => undefined), subscribe },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    sessions: {
      state: { result: null, loading: false },
      list: vi.fn(async () => null),
      subscribe,
    },
    workboard: { subscribe },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext): TestPage {
  const page = document.createElement("openclaw-skills-page") as TestPage;
  page.context = context;
  page.render = () => nothing;
  return page;
}

function linkedSkillReport() {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [
      {
        name: "AgentReceipt",
        skillKey: "agentreceipt",
        source: "workspace",
        clawhub: {
          status: "linked",
          valid: true,
          registry: "https://clawhub.ai",
          slug: "agentreceipt",
          installedVersion: "1.2.3",
          installedAt: 123,
        },
      },
    ],
  };
}

function routeDataFor(
  context: ApplicationContext,
  report: SkillsRouteData["report"],
): SkillsRouteData {
  return {
    gateway: context.gateway,
    gatewaySnapshot: context.gateway.snapshot,
    agents: context.agents,
    agentsList: null,
    selectedAgentId: null,
    report,
    error: null,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("skills page route-loaded reports", () => {
  it("hydrates ClawHub verdicts for a route-loaded linked-skills report", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [
            {
              registry: "https://clawhub.ai",
              ok: true,
              decision: "pass",
              reasons: [],
              requestedSlug: "agentreceipt",
              requestedVersion: "1.2.3",
              slug: "agentreceipt",
              version: "1.2.3",
              securityStatus: "clean",
              securityPassed: true,
            },
          ],
        };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const page = createPage(context);
    page.routeData = routeDataFor(context, linkedSkillReport() as SkillsRouteData["report"]);

    document.body.append(page);
    await page.updateComplete;

    await waitForFast(() => expect(request).toHaveBeenCalledWith("skills.securityVerdicts", {}));
    expect(page.clawhubVerdicts).toEqual({
      "https://clawhub.ai\u0000\u0000agentreceipt\u00001.2.3": expect.objectContaining({
        ok: true,
        decision: "pass",
        securityStatus: "clean",
        securityPassed: true,
      }),
    });
    expect(page.clawhubVerdictsLoading).toBe(false);
    expect(page.clawhubVerdictsError).toBeNull();
  });

  it("does not request verdicts for a route-loaded report without linked ClawHub skills", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const page = createPage(context);
    page.routeData = routeDataFor(context, {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Local", skillKey: "local", source: "workspace" }],
    } as SkillsRouteData["report"]);

    document.body.append(page);
    await page.updateComplete;

    expect(request).not.toHaveBeenCalledWith("skills.securityVerdicts", expect.anything());
    expect(page.clawhubVerdicts).toEqual({});
  });
});
