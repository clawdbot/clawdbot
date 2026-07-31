/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import type { DreamingState } from "./dreaming.ts";
import type { DreamingViewState } from "./view.ts";
import "./memory-panel.ts";

type TestMemoryPanel = HTMLElement & {
  context: ApplicationContext;
  agentId: string;
  dreaming: DreamingState;
  viewState: DreamingViewState;
  toggleConfirmOpen: boolean;
  toggleConfirmLoading: boolean;
  pendingEnabled: boolean | null;
  applyAgentId: () => void;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadAll: () => Promise<void>;
  openWikiPage: (lookup: string) => Promise<unknown>;
  resetEnabledOverride: (configured: {
    pluginId: string;
    enabled: boolean;
    overridden: boolean;
    engineOff: boolean;
  }) => Promise<void>;
  render: () => unknown;
  requestUpdate: () => void;
  readonly updateComplete: Promise<boolean>;
};

let restoreTranslations = () => {};

beforeAll(() => {
  const dreaming =
    en.dreaming && typeof en.dreaming === "object" ? (en.dreaming as TranslationMap) : {};
  const wiki =
    dreaming.wiki && typeof dreaming.wiki === "object" ? (dreaming.wiki as TranslationMap) : {};
  i18n.registerTranslation("en", {
    ...en,
    dreaming: {
      ...dreaming,
      wiki: {
        ...wiki,
        noContent: "No wiki content available.",
      },
    },
  });
  restoreTranslations = () => i18n.registerTranslation("en", en);
});

afterAll(() => {
  restoreTranslations();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextWithGateway(
  client: GatewayBrowserClient,
  connected: boolean,
  configForm: Record<string, unknown> | null = null,
): ApplicationContext {
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
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: { agentsList: null },
      subscribe,
    },
    runtimeConfig: {
      state: { configForm, configSnapshot: null },
      refresh: vi.fn(async () => undefined),
      removeFormValue: vi.fn(),
      waitForPendingWrites: vi.fn(async () => undefined),
      save: vi.fn(async () => true),
      patch: vi.fn(async () => true),
      subscribe,
    },
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext): TestMemoryPanel {
  const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
  page.context = context;
  page.agentId = "main";
  page.render = () => nothing;
  page.loadAll = vi.fn(async () => undefined);
  return page;
}

async function replaceContext(page: TestMemoryPanel, context: ApplicationContext) {
  page.context = context;
  page.requestUpdate();
  await page.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AgentMemoryPanel gateway lifecycle", () => {
  it("loads the selected agent on the first gateway bind", async () => {
    const client = {} as GatewayBrowserClient;
    const context = contextWithGateway(client, true);
    const page = createPage(context);

    document.body.append(page);
    await page.updateComplete;

    expect(page.dreaming.selectedAgentId).toBe("main");
    expect(page.loadAll).toHaveBeenCalledOnce();
  });

  it("resets stale panel data when the selected agent changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "main-only";

    page.agentId = "support";
    await page.updateComplete;

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.selectedAgentId).toBe("support");
    expect(page.dreaming.dreamDiaryContent).toBeNull();
  });

  it("resets provider and modal state when the gateway source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, false));
    document.body.append(page);
    await page.updateComplete;
    const previousState = page.dreaming;
    previousState.dreamDiaryContent = "old provider";
    page.viewState.wikiPreviewOpen = true;
    page.viewState.wikiPreviewLoading = true;
    page.viewState.wikiPreviewTitle = "Old page";
    page.viewState.wikiPreviewContent = "old wiki";
    page.toggleConfirmOpen = true;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = true;

    await replaceContext(page, contextWithGateway(client, false));

    expect(page.dreaming).not.toBe(previousState);
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.viewState.wikiPreviewLoading).toBe(false);
    expect(page.viewState.wikiPreviewTitle).toBe("");
    expect(page.viewState.wikiPreviewContent).toBe("");
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();

    page.viewState.wikiPreviewOpen = true;
    page.toggleConfirmOpen = true;
    page.toggleConfirmLoading = true;
    page.pendingEnabled = false;
    page.remove();

    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.toggleConfirmOpen).toBe(false);
    expect(page.toggleConfirmLoading).toBe(false);
    expect(page.pendingEnabled).toBeNull();
  });

  it("discards a wiki response from a replaced gateway source", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;

    const preview = page.openWikiPage("old.md");
    await replaceContext(page, contextWithGateway(client, false));
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
  });

  it("discards a wiki response across a same-client reconnect", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;

    const previousState = page.dreaming;
    const preview = page.openWikiPage("old.md");
    page.applyGatewaySnapshot({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    pending.resolve({ title: "Old", path: "old.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
    expect(page.dreaming).not.toBe(previousState);
    expect(page.viewState.wikiPreviewContent).toBe("");
  });

  it("loads wiki previews for the selected agent", async () => {
    const request = vi.fn(async () => ({
      title: "Support",
      path: "support.md",
      content: "support-only",
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    document.body.append(page);
    await page.updateComplete;

    await page.openWikiPage("support.md");

    expect(request).toHaveBeenCalledWith("wiki.get", {
      lookup: "support.md",
      fromLine: 1,
      lineCount: 5000,
      agentId: "support",
    });
  });

  it("resets the config-only dreaming override to the enabled runtime default", async () => {
    const client = {
      request: vi.fn(async () => ({ dreaming: { enabled: true } })),
    } as unknown as GatewayBrowserClient;
    const context = contextWithGateway(client, true, {
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    });
    const page = createPage(context);
    document.body.append(page);
    await page.updateComplete;

    await page.resetEnabledOverride({
      pluginId: "memory-core",
      enabled: false,
      overridden: true,
      engineOff: false,
    });

    expect(context.runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        plugins: {
          entries: {
            "memory-core": { config: { dreaming: { enabled: null } } },
          },
        },
      },
      note: "Dreaming settings reset to the plugin default.",
    });
    expect(context.runtimeConfig.removeFormValue).not.toHaveBeenCalled();
    expect(context.runtimeConfig.save).not.toHaveBeenCalled();
    expect(context.runtimeConfig.refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh the stale override when the minimal reset patch fails", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const context = contextWithGateway(client, true, {
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    });
    vi.mocked(context.runtimeConfig.patch).mockResolvedValue(false);
    const page = createPage(context);
    document.body.append(page);
    await page.updateComplete;

    await page.resetEnabledOverride({
      pluginId: "memory-core",
      enabled: false,
      overridden: true,
      engineOff: false,
    });

    expect(context.runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(context.runtimeConfig.removeFormValue).not.toHaveBeenCalled();
    expect(context.runtimeConfig.save).not.toHaveBeenCalled();
    expect(context.runtimeConfig.refresh).not.toHaveBeenCalled();
  });

  it("drops a successful reset completion after the agent scope changes", async () => {
    const pending = deferred<boolean>();
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    });
    vi.mocked(context.runtimeConfig.patch).mockReturnValue(pending.promise);
    const page = createPage(context);
    document.body.append(page);
    await page.updateComplete;

    const reset = page.resetEnabledOverride({
      pluginId: "memory-core",
      enabled: false,
      overridden: true,
      engineOff: false,
    });
    page.agentId = "support";
    await page.updateComplete;
    pending.resolve(true);
    await reset;

    expect(context.runtimeConfig.refresh).not.toHaveBeenCalled();
    expect(page.dreaming.dreamingStatusError).toBeNull();
  });

  it("renders explicit engine Off as unavailable while preserving latent override reset", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: {
        slots: { memory: "none" },
        entries: {
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    render(page.render(), container);

    expect(container.textContent).toContain(
      "Memory engine is Off. Choose an engine in Settings to enable dreaming.",
    );
    expect(container.textContent).not.toContain("Using default: Enabled");
    expect(container.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.disabled).toBe(
      true,
    );
    expect(container.querySelector('button[aria-label="Reset to default"]')).not.toBeNull();
  });

  it("does not present cached runtime status after the memory engine switches Off", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "none" } },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    page.dreaming.dreamingStatus = {
      enabled: true,
      promotedToday: 7,
      timezone: "Mars/Base",
      phases: {
        light: { enabled: true, cron: "* * * * *", managedCronPresent: true },
        deep: {
          enabled: true,
          cron: "* * * * *",
          managedCronPresent: true,
          limit: 1,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          recencyHalfLifeDays: 1,
        },
        rem: {
          enabled: true,
          cron: "* * * * *",
          managedCronPresent: true,
          lookbackDays: 1,
          limit: 1,
          minPatternStrength: 0,
        },
      },
    } as NonNullable<DreamingState["dreamingStatus"]>;
    const container = document.createElement("div");

    render(page.render(), container);

    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.textContent).toContain("Off");
    expect(toggle?.classList.contains("dreams__phase-toggle--on")).toBe(false);
    expect(container.querySelector(".dreams__status-label")?.textContent).toContain("Idle");
    expect(container.textContent).toContain("0 promoted");
    expect(container.textContent).not.toContain("7 promoted");
    expect(container.textContent).not.toContain("Mars/Base");
    expect(
      [...container.querySelectorAll(".dreams__phase-next")].every(
        (phase) => phase.textContent?.trim() === "—",
      ),
    ).toBe(true);
  });

  it("omits default provenance and reset when engine Off has no latent override", () => {
    const context = contextWithGateway({} as GatewayBrowserClient, true, {
      plugins: { slots: { memory: "none" } },
    });
    const page = document.createElement("openclaw-agent-memory-panel") as TestMemoryPanel;
    page.context = context;
    page.agentId = "main";
    const container = document.createElement("div");

    render(page.render(), container);

    expect(container.textContent).not.toContain("Using default: Enabled");
    expect(container.querySelector('button[aria-label="Reset to default"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(".dreams__phase-toggle");
    expect(toggle?.disabled).toBe(true);
    toggle?.click();
    expect(page.pendingEnabled).toBeNull();
  });

  it("uses localized empty content for wiki previews", async () => {
    const client = {
      request: vi.fn(async () => ({ title: "Empty", path: "empty.md", content: "" })),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    document.body.append(page);
    await page.updateComplete;

    await expect(page.openWikiPage("empty.md")).resolves.toMatchObject({
      content: "No wiki content available.",
    });
  });

  it("discards a wiki preview after the selected agent changes", async () => {
    const pending = deferred<unknown>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    document.body.append(page);
    await page.updateComplete;

    const preview = page.openWikiPage("support.md");
    page.agentId = "marketing";
    await page.updateComplete;
    pending.resolve({ title: "Support", path: "support.md", content: "stale" });

    await expect(preview).resolves.toBeNull();
  });

  it("closes an open wiki preview when the selected agent changes", async () => {
    const client = {
      request: vi.fn(async () => ({})),
    } as unknown as GatewayBrowserClient;
    const page = createPage(contextWithGateway(client, true));
    page.agentId = "support";
    document.body.append(page);
    await page.updateComplete;
    page.viewState.wikiPreviewOpen = true;
    page.viewState.wikiPreviewLoading = true;
    page.viewState.wikiPreviewContent = "support-only";

    page.agentId = "marketing";
    await page.updateComplete;

    expect(page.viewState.wikiPreviewOpen).toBe(false);
    expect(page.viewState.wikiPreviewLoading).toBe(false);
    expect(page.viewState.wikiPreviewContent).toBe("");
  });
});
