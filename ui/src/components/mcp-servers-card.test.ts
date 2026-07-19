/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./mcp-servers-card.ts";

type McpServersCard = HTMLElementTagNameMap["openclaw-mcp-servers-card"];

type RuntimeConfigHarness = {
  runtimeConfig: ApplicationContext["runtimeConfig"];
  ensureLoaded: ReturnType<typeof vi.fn<() => Promise<void>>>;
  patch: ReturnType<
    typeof vi.fn<(options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>>
  >;
};

function createGateway(options: { connected?: boolean; admin?: boolean } = {}): ApplicationGateway {
  const connected = options.connected ?? true;
  const admin = options.admin ?? true;
  const snapshot = {
    client: null,
    connected,
    reconnecting: !connected,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: {
        role: "operator",
        scopes: admin ? ["operator.read", "operator.admin"] : ["operator.read"],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
}

function createRuntimeConfig(config: Record<string, unknown>): RuntimeConfigHarness {
  const ensureLoaded = vi.fn(async () => undefined);
  const patch = vi.fn<
    (options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>
  >(async () => true);
  const listeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: { sourceConfig: config, hash: "base" },
      lastError: null,
    },
    ensureLoaded,
    patch,
    refresh: vi.fn(async () => undefined),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationContext["runtimeConfig"];
  return { runtimeConfig, ensureLoaded, patch };
}

async function mountCard(
  options: {
    config?: Record<string, unknown>;
    connected?: boolean;
    admin?: boolean;
  } = {},
): Promise<{
  card: McpServersCard;
  provider: ApplicationContextProvider;
  harness: RuntimeConfigHarness;
}> {
  const harness = createRuntimeConfig(options.config ?? { mcp: { servers: {} } });
  const context = {
    gateway: createGateway({ connected: options.connected, admin: options.admin }),
    runtimeConfig: harness.runtimeConfig,
    basePath: "",
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const card = document.createElement("openclaw-mcp-servers-card");
  card.pluginsHref = "/settings/plugins";
  provider.append(card);
  document.body.append(provider);
  await card.updateComplete;
  await waitForFast(() => expect(harness.ensureLoaded).toHaveBeenCalled());
  await card.updateComplete;
  return { card, provider, harness };
}

function actionButton(container: Element, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").includes(label),
  );
  return expectDefined(button, `${label} button`);
}

async function submitAddForm(card: McpServersCard, name: string, target: string) {
  actionButton(card, "Add server").click();
  await card.updateComplete;
  const form = expectDefined(card.querySelector<HTMLFormElement>(".mcp-server-form"), "MCP form");
  expectDefined(form.querySelector<HTMLInputElement>('[name="mcp-name"]'), "name input").value =
    name;
  expectDefined(form.querySelector<HTMLInputElement>('[name="mcp-target"]'), "target input").value =
    target;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function firstPatchCall(harness: RuntimeConfigHarness) {
  return expectDefined(
    expectDefined(harness.patch.mock.calls[0], "config patch call")[0],
    "config patch payload",
  );
}

describe("openclaw-mcp-servers-card", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders rich rows without exposing URL credentials or stdio arguments", async () => {
    const { card } = await mountCard({
      config: {
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com/mcp?keep=visible&token=test-token",
              auth: "oauth",
              toolFilter: { include: ["search"] },
              sslVerify: false,
            },
            local: {
              command: "node",
              args: ["server.js", "--token", "test-token"],
              enabled: false,
              supportsParallelToolCalls: true,
              clientCert: "/tmp/client.pem",
            },
            // Config files can carry names the add form would reject; the
            // command snippet must stay shell-safe for copy/paste.
            "docs; echo unsafe": { url: "https://mcp.example.com/mcp" },
          },
        },
      },
    });

    const docs = expectDefined(card.querySelector('[data-mcp-name="docs"]'), "docs row");
    expect(docs.textContent).toContain("https://mcp.example.com/mcp?keep=visible&token=***");
    expect(docs.textContent).toContain("http · oauth · tool filter · TLS verify off");
    expect(docs.textContent).toContain("openclaw mcp login docs");
    expect(docs.textContent).not.toContain("test-token");

    const local = expectDefined(card.querySelector('[data-mcp-name="local"]'), "local row");
    expect(local.textContent).toContain("node");
    expect(local.textContent).toContain("stdio · parallel · mTLS");
    expect(local.textContent).toContain("openclaw mcp probe local");
    expect(local.textContent).not.toContain("server.js");
    expect(local.textContent).not.toContain("test-token");

    const hostile = expectDefined(
      card.querySelector('[data-mcp-name="docs; echo unsafe"]'),
      "hostile-name row",
    );
    expect(hostile.textContent).toContain("openclaw mcp probe 'docs; echo unsafe'");
  });

  it("renders the empty state when no servers are configured", async () => {
    const { card } = await mountCard();

    expect(card.querySelector(".settings-empty")?.textContent).toContain(
      "No MCP servers configured.",
    );
  });

  it.each([
    {
      label: "streamable HTTP URL",
      target: "https://mcp.context7.com/mcp",
      expected: { url: "https://mcp.context7.com/mcp", transport: "streamable-http" },
    },
    {
      label: "SSE URL",
      target: "https://mcp.example.com/sse?token=test",
      expected: { url: "https://mcp.example.com/sse?token=test", transport: "sse" },
    },
    {
      label: "stdio command",
      target: "npx some-mcp-server --stdio",
      expected: { command: "npx", args: ["some-mcp-server", "--stdio"] },
    },
  ])("adds a server from a $label", async ({ target, expected }) => {
    const { card, harness } = await mountCard();

    await submitAddForm(card, "context7", target);

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { context7: expected } } },
      note: "mcp settings: add server context7",
    });
    await waitForFast(() =>
      expect(card.querySelector('[role="status"]')?.textContent).toContain(
        "Added MCP server context7.",
      ),
    );
    expect(card.querySelector(".mcp-server-form")).toBeNull();
  });

  it("rejects an invalid name before patching", async () => {
    const { card, harness } = await mountCard();

    await submitAddForm(card, "bad name!", "https://mcp.example.com/mcp");

    await waitForFast(() =>
      expect(card.querySelector('[role="alert"]')?.textContent).toContain("Server names use"),
    );
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name before patching", async () => {
    const { card, harness } = await mountCard({
      config: { mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } } },
    });

    await submitAddForm(card, "docs", "https://other.example.com/mcp");

    await waitForFast(() =>
      expect(card.querySelector('[role="alert"]')?.textContent).toContain(
        "An MCP server named “docs” already exists.",
      ),
    );
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it.each([
    {
      current: { command: "node", enabled: false },
      action: "Enable",
      expected: { enabled: null },
      note: "mcp settings: enable server local",
    },
    {
      current: { command: "node" },
      action: "Disable",
      expected: { enabled: false },
      note: "mcp settings: disable server local",
    },
  ])("writes the exact merge patch for $action", async ({ current, action, expected, note }) => {
    const { card, harness } = await mountCard({
      config: { mcp: { servers: { local: current } } },
    });

    actionButton(card, action).click();

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { local: expected } } },
      note,
    });
  });

  it("removes a server with an explicit merge-patch null", async () => {
    const { card, harness } = await mountCard({
      config: { mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } } },
    });

    actionButton(card, "Remove docs").click();

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { docs: null } } },
      note: "mcp settings: remove server docs",
    });
  });

  it("disables mutation controls without operator.admin access", async () => {
    const { card, harness } = await mountCard({
      admin: false,
      config: { mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } } },
    });

    const controls = [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((button) => button.disabled)).toBe(true);
    expect(controls.every((button) => button.title.includes("operator.admin"))).toBe(true);
    actionButton(card, "Disable").click();
    expect(harness.patch).not.toHaveBeenCalled();
  });
});
