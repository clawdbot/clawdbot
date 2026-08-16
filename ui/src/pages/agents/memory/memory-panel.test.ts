/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import {
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "../../../components/confirm-dialog.ts";
import { i18n } from "../../../i18n/index.ts";
import type { TranslationMap } from "../../../i18n/lib/types.ts";
import { en } from "../../../i18n/locales/en.ts";
import type { DreamingState } from "./dreaming.ts";
import type { DreamingViewState } from "./view.ts";
import "./memory-panel.ts";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

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
  confirmDreamingTask: (
    task: (state: DreamingState) => Promise<boolean>,
    confirmation: ConfirmDialogOptions,
  ) => Promise<void>;
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
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("AgentMemoryPanel gateway lifecycle", () => {
  it("does not run a confirmed dreaming action after the selected agent changes", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const page = createPage(contextWithGateway({} as GatewayBrowserClient, true));
    const task = vi.fn(async () => true);
    document.body.append(page);
    await page.updateComplete;

    const pending = page.confirmDreamingTask(task, { message: "Repair?" });
    page.agentId = "support";
    await page.updateComplete;
    confirmation.resolve(true);
    await pending;

    expect(task).not.toHaveBeenCalled();
  });

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
      canDispatch: expect.any(Function),
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

describe.runIf(process.env.OPENCLAW_UI_MEMORY_CHROMIUM_E2E === "1")(
  "agent memory real Chromium owner proof",
  () => {
    let browser: import("playwright").Browser;
    let server: import("../../../test-helpers/control-ui-e2e.ts").ControlUiE2eServer;
    let e2e: typeof import("../../../test-helpers/control-ui-e2e.ts");

    beforeAll(async () => {
      const { chromium } = await import("playwright");
      e2e = await import("../../../test-helpers/control-ui-e2e.ts");
      const executablePath = e2e.resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
      if (!e2e.canRunPlaywrightChromium(executablePath)) {
        throw new Error(`Real Chromium required but unavailable: ${executablePath}`);
      }
      server = await e2e.startControlUiE2eServer();
      browser = await chromium.launch({ executablePath, headless: true });
    }, 90_000);

    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("preserves both routes, agent ownership, wiki gating, and reconnects", async () => {
      const status = (agentId: string, promotedToday: number) => ({
        agentId,
        provider: "builtin",
        embedding: { ok: true, checked: true },
        dreaming: {
          enabled: true,
          verboseLogging: false,
          storageMode: "inline" as const,
          separateReports: false,
          shortTermCount: promotedToday,
          recallSignalCount: 0,
          dailySignalCount: 0,
          groundedSignalCount: 0,
          totalSignalCount: 0,
          phaseSignalCount: 0,
          lightPhaseHitCount: 0,
          remPhaseHitCount: 0,
          promotedTotal: promotedToday,
          promotedToday,
          shortTermEntries: [],
          signalEntries: [],
          promotedEntries: [],
          phases: {
            light: {
              enabled: true,
              cron: "0 * * * *",
              managedCronPresent: true,
              lookbackDays: 2,
              limit: 10,
            },
            deep: {
              enabled: true,
              cron: "0 3 * * *",
              managedCronPresent: true,
              limit: 10,
              minScore: 0.8,
              minRecallCount: 2,
              minUniqueQueries: 2,
              recencyHalfLifeDays: 14,
            },
            rem: {
              enabled: false,
              cron: "0 5 * * 0",
              managedCronPresent: false,
              lookbackDays: 7,
              limit: 10,
              minPatternStrength: 0.75,
            },
          },
        },
      });
      const diary = (agentId: string) => ({
        agentId,
        found: true,
        path: "DREAMS.md",
        content: `# Dream Diary\n\n*April 5, 2026, 3:00 AM*\n\n${agentId} owns this dream.`,
      });
      const config = {
        agents: { entries: { main: { default: true }, support: {} } },
        plugins: {
          entries: {
            "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
          },
        },
      };
      const roster = {
        agents: [
          { id: "main", name: "Main" },
          { id: "support", name: "Support" },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await e2e.installMockGateway(page, {
        webSocketPassthroughPrefixes: [`${e2e.controlUiBundledGatewayUrl(server.baseUrl)}/?token=`],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "doctor.memory.status",
          "doctor.memory.dreamDiary",
        ],
        methodResponses: {
          "agents.list": roster,
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "memory-proof-1",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "plugins.list": {
            plugins: [
              {
                id: "memory-core",
                name: "OpenClaw Memory",
                installed: true,
                enabled: true,
                state: "enabled",
                kind: ["memory"],
              },
            ],
            diagnostics: [],
            mutationAllowed: true,
          },
          "doctor.memory.status": {
            cases: [
              { match: { agentId: "main" }, response: status("main", 11) },
              { match: { agentId: "support" }, response: status("support", 22) },
            ],
          },
          "doctor.memory.dreamDiary": {
            cases: [
              { match: { agentId: "main" }, response: diary("main") },
              { match: { agentId: "support" }, response: diary("support") },
            ],
          },
        },
      });
      const detail = () => page.locator("openclaw-agent-memory-panel .dreams__status-detail");
      const requestCount = () =>
        gateway.getRequests("doctor.memory.status").then((requests) => requests.length);
      const chooseAgent = async (name: string) => {
        const picker = page.locator(".memory-page .agent-scope-control openclaw-agent-select");
        await picker.locator(".agent-select__trigger").click();
        await picker
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: name })
          .evaluate((item) => (item as HTMLElement).click());
      };

      try {
        expect((await page.goto(`${server.baseUrl}settings/agents/main/memory`))?.status()).toBe(
          200,
        );
        await e2e.waitForControlUiRoute(page, {
          routeId: "agents",
          pathname: "/settings/agents/main/memory",
        });
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("11 promoted");
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);

        const beforeFirstMain = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await page.evaluate(() => {
          history.pushState(null, "", "/settings/memory/dreams");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await e2e.waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/settings/memory/dreams",
        });
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeFirstMain);

        const beforeSupport = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await chooseAgent("Support");
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeSupport);
        await gateway.setMethodResponse("doctor.memory.status", {
          cases: [
            { match: { agentId: "main" }, response: status("main", 33) },
            { match: { agentId: "support" }, response: status("support", 22) },
          ],
        });
        await chooseAgent("Main");
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("33 promoted");
        await gateway.resolveDeferred("doctor.memory.status", status("main", 11));
        await gateway.resolveDeferred("doctor.memory.status", status("support", 22));
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("33 promoted");
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);

        await gateway.setMethodResponse("doctor.memory.status", status("main", 44));
        const beforeReconnect = await requestCount();
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "proxy idle timeout");
        await gateway.setOnline(false);
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (
                    document.querySelector("openclaw-app") as HTMLElement & {
                      runtime?: { context: { gateway: { snapshot: { phase: string } } } };
                    }
                  ).runtime?.context.gateway.snapshot.phase,
              ),
            { timeout: 15_000 },
          )
          .toBe("reconnecting");
        await expect
          .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
          .toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await expect.poll(requestCount, { timeout: 15_000 }).toBeGreaterThan(beforeReconnect);
        await expect
          .poll(async () => await detail().textContent(), { timeout: 15_000 })
          .toContain("44 promoted");
        await e2e.waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/settings/memory/dreams",
        });
      } finally {
        await context.close();
      }
    }, 120_000);
  },
);
