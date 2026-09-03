/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./github-connections.ts";

const system = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-account" },
  gitAuthor: { name: null, email: null },
  evidence: "github-api",
  accessExpiresAtMs: null,
  refreshState: "available",
  oauthScopes: [],
  repositoryGrants: "unknown",
} as const;
const disconnected = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
} as const;
function mount(scopes: string[], profileId: string | null, request: ReturnType<typeof vi.fn>) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods([], scopes),
    selfUser: profileId ? { id: profileId } : null,
  } as ApplicationGatewaySnapshot;
  const context = {
    gateway: {
      snapshot,
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agents: { state: { agentsList: { defaultId: "main" } }, subscribe: () => () => undefined },
    runtimeConfig: {
      state: {},
      subscribe: () => () => undefined,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
    },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-github-connections");
  provider.append(element);
  document.body.append(provider);
  return {
    element,
    context,
    update: (patch: Partial<ApplicationGatewaySnapshot>) => {
      Object.assign(snapshot, patch);
      for (const listener of listeners) {
        listener({ ...snapshot });
      }
    },
  };
}
afterEach(() => {
  document.body.replaceChildren();
});

it("renders reader self-service independently of profile mutation and shared configuration", async () => {
  const request = vi.fn(async () => ({ personal: disconnected, system }));
  const { element, context } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("@system-account"));
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
  expect(element.textContent).toContain("Connect My GitHub");
  expect(element.textContent).toContain("Admin managed");
  expect(element.textContent).not.toContain("Change System GitHub");
  expect(element.textContent).not.toContain("Use a PAT instead");
});

it("uses explicit unbound admin context for System without probing personal status", async () => {
  const request = vi.fn(async () => ({
    agentId: "main",
    selectedScope: "system",
    selected: { scope: "system", configured: true, identity: system },
    effective: { ...system, source: "agent-override", account: { login: "agent-account" } },
  }));
  const { element } = mount(["operator.admin"], null, request);
  await waitForFast(() => expect(element.textContent).toContain("@system-account"));
  expect(request.mock.calls).toEqual([
    ["tools.github.status", { agentId: "main", selectedScope: "system" }],
  ]);
  expect(element.textContent).toContain("Personal sign-in required");
  expect(element.textContent).not.toContain("Connect My GitHub");
  expect(element.textContent).not.toContain("@agent-account");
});

it("shows an identified status failure once while opening personal setup", async () => {
  const request = vi.fn(async () => {
    throw new Error("GitHub status temporarily unavailable");
  });
  const { element } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "GitHub status temporarily unavailable",
    ),
  );
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(element.textContent).not.toContain("Change System GitHub");
  expect(element.textContent).toContain("Retry");
  Array.from(element.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Connect GitHub")
    ?.click();
  await waitForFast(() => expect(element.querySelector("[data-github-setup]")).not.toBeNull());
  expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
});
