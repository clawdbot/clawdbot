/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import { CONNECTOR_SUGGESTIONS } from "./presentation.ts";
import { pluginRowKey, renderPlugins } from "./view.ts";

type PluginsViewProps = Parameters<typeof renderPlugins>[0];

function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: "Agent work queue and session handoff.",
    version: "1.0.0",
    kind: ["productivity"],
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    category: "tool",
    removable: false,
    ...overrides,
  };
}

function createResult(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function createProps(overrides: Partial<PluginsViewProps> = {}): PluginsViewProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    activeTab: "installed",
    query: "",
    installedFilter: "all",
    searchResults: null,
    searchLoading: false,
    searchError: null,
    busy: {},
    messages: {},
    pendingRemoval: {},
    detailPluginId: null,
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    pageNotice: null,
    mcpSettingsHref: "/settings/mcp",
    mcpServers: [],
    mcpMessage: null,
    mcpBusy: false,
    mcpFormOpen: false,
    onQueryChange: () => undefined,
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onIconError: () => undefined,
    onShowDetails: () => undefined,
    onSetEnabled: () => undefined,
    onInstall: () => undefined,
    onDismissMessage: () => undefined,
    onRequestUninstall: () => undefined,
    onCancelUninstall: () => undefined,
    onUninstall: () => undefined,
    onAddConnector: () => undefined,
    onSearchClawHub: () => undefined,
    onMcpToggle: () => undefined,
    onMcpRemove: () => undefined,
    onMcpFormToggle: () => undefined,
    onMcpAdd: () => undefined,
    ...overrides,
  };
}

function mount(props: PluginsViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPlugins(props), container);
  return container;
}

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function actionButton(container: Element, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      (button.getAttribute("aria-label") ?? normalizedText(button)).includes(label),
    ) ?? null
  );
}

function clawHubKey(packageName: string): string {
  return `clawhub:${packageName}`;
}

describe("renderPlugins", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders grouped inventory counts", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "telegram",
        name: "Telegram",
        category: "channel",
        enabled: true,
        state: "enabled",
        featured: false,
      }),
      createPlugin({
        id: "broken",
        name: "Broken",
        category: "channel",
        state: "error",
        error: "manifest invalid",
        featured: false,
      }),
    ];
    const container = mount(createProps({ result: createResult(plugins) }));
    const filterBar = container.querySelector(".settings-segmented");
    expect(normalizedText(filterBar?.querySelector('[slot="label"]') ?? null)).toBeTruthy();
    expect(
      container.querySelector('[data-plugin-id="telegram"] h3.settings-row__title')?.textContent,
    ).toContain("Telegram");
    expect(normalizedText(filterBar)).toContain("All 3");
    expect(normalizedText(filterBar)).toContain("Enabled 1");
    expect(normalizedText(filterBar)).toContain("Issues 1");
    expect(
      container.querySelector('[data-plugin-id="broken"] [role="alert"]')?.textContent,
    ).toContain("manifest invalid");
  });

  it("keeps plugin fallback monograms on complete grapheme clusters", () => {
    const cases = [
      { id: "emoji-tools", name: "😀 Tools", expected: "😀T" },
      { id: "mixed-emoji", name: "A😀", expected: "A😀" },
      { id: "heart-tools", name: "❤️ Tools", expected: "❤️T" },
      { id: "flag-tools", name: "🇺🇸 Tools", expected: "🇺🇸T" },
      { id: "developer-tools", name: "👩‍💻 Tools", expected: "👩‍💻T" },
      { id: "developer-name", name: "👩‍💻Dev", expected: "👩‍💻D" },
      { id: "combining-mark", name: "é Tools", expected: "ÉT" },
    ];
    const plugins = cases.map(({ id, name }) => createPlugin({ id, name, origin: "global" }));
    const container = mount(createProps({ result: createResult(plugins) }));

    for (const { id, expected } of cases) {
      expect(
        container.querySelector(`[data-plugin-id="${id}"] .plugins-tile--fallback > span`)
          ?.textContent,
      ).toBe(expected);
    }
  });

  it("renders proxied plugin icons and falls back after an image error", () => {
    const plugin = createPlugin({
      id: "remote-icon",
      name: "FireCrawl",
      origin: "official",
      hasIcon: true,
    });
    const onIconError = vi.fn();
    const first = mount(
      createProps({
        result: createResult([plugin]),
        iconUrls: { "remote-icon": "blob:firecrawl-icon" },
        onIconError,
      }),
    );
    const image = first.querySelector<HTMLImageElement>(
      '[data-plugin-id="remote-icon"] .plugins-tile img.plugins-icon',
    );
    expect(image?.getAttribute("src")).toBe("blob:firecrawl-icon");
    image?.dispatchEvent(new Event("error"));
    expect(onIconError).toHaveBeenCalledWith("remote-icon");

    const fallback = mount(createProps({ result: createResult([plugin]) }));
    expect(
      fallback.querySelector('[data-plugin-id="remote-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("FI");
  });

  it("keeps plugin monograms usable when Intl.Segmenter is unavailable", async () => {
    const originalSegmenter = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    vi.resetModules();

    try {
      const freshModulePath = "./presentation.ts?without-intl-segmenter";
      const { pluginMonogram } = await import(/* @vite-ignore */ freshModulePath);
      expect(pluginMonogram("😀 Tools")).toBe("😀T");
      expect(pluginMonogram("👩‍💻 Tools")).toBe("👩T");
    } finally {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: originalSegmenter });
      vi.resetModules();
    }
  });

  it("filters the installed inventory by state", () => {
    const plugins = [
      createPlugin({ id: "on", name: "On", enabled: true, state: "enabled" }),
      createPlugin({ id: "off", name: "Off" }),
      createPlugin({ id: "broken", name: "Broken", state: "error" }),
    ];
    const onFilterChange = vi.fn();
    const container = mount(createProps({ result: createResult(plugins), onFilterChange }));
    const chips = container.querySelectorAll<HTMLElement>(
      ".settings-segmented .settings-segmented__btn",
    );
    expect(chips).toHaveLength(4);
    const issues = expectDefined(chips[3], "issues filter chip");
    const group = issues.closest<HTMLElement & { value: string }>("wa-radio-group");
    expect(group).not.toBeNull();
    if (group) {
      group.value = "issues";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onFilterChange).toHaveBeenCalledWith("issues");
  });

  it.each(["@openclaw/workboard", "  @OPENCLAW/WORKBOARD  "])(
    "finds an installed plugin by its scoped package name %s",
    (query) => {
      const plugin = createPlugin({ packageName: "@openclaw/workboard" });
      const container = mount(createProps({ query, result: createResult([plugin]) }));

      expect(container.querySelector('[data-plugin-id="workboard"]')).not.toBeNull();
      expect(normalizedText(container)).toContain("@openclaw/workboard");
    },
  );

  it.each([
    { shelf: "featured", featured: true },
    { shelf: "official", featured: false },
  ])("finds an official $shelf plugin by its scoped package name", ({ featured }) => {
    const plugin = createPlugin({
      id: "calendar-runtime",
      name: "Shared Calendar",
      packageName: "@openclaw/calendar-runtime",
      description: "Schedule team events.",
      origin: "official",
      installed: false,
      enabled: false,
      state: "not-installed",
      featured,
      install: { source: "official", pluginId: "calendar-runtime" },
    });
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "@openclaw/calendar-runtime",
        result: createResult([plugin]),
      }),
    );

    expect(container.querySelector('[data-plugin-id="calendar-runtime"]')).not.toBeNull();
  });

  it("offers enable and remove through direct row actions", () => {
    const onSetEnabled = vi.fn();
    const onRequestUninstall = vi.fn();
    const removableKey = pluginRowKey("community-thing");
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "community-thing",
        name: "Community Thing",
        origin: "global",
        removable: true,
        featured: false,
      }),
    ];
    const container = mount(
      createProps({ result: createResult(plugins), onSetEnabled, onRequestUninstall }),
    );
    const row = container.querySelector<HTMLElement>('[data-plugin-id="community-thing"]')!;
    actionButton(row, "Enable")?.click();
    expect(onSetEnabled).toHaveBeenCalledWith("community-thing", true, removableKey);
    actionButton(row, "Remove Community Thing")?.click();
    expect(onRequestUninstall).toHaveBeenCalledWith(removableKey);

    // Bundled plugins cannot be removed; the row still offers enable/disable.
    const bundledRow = container.querySelector<HTMLElement>('[data-plugin-id="workboard"]')!;
    expect(actionButton(bundledRow, "Remove")).toBeNull();
    expect(actionButton(bundledRow, "Enable")).not.toBeNull();
  });

  it("confirms removal before uninstalling", () => {
    const onUninstall = vi.fn();
    const onCancelUninstall = vi.fn();
    const rowKey = pluginRowKey("community-thing");
    const plugins = [
      createPlugin({
        id: "community-thing",
        name: "Community Thing",
        origin: "global",
        removable: true,
        featured: false,
      }),
    ];
    const container = mount(
      createProps({
        result: createResult(plugins),
        pendingRemoval: { [rowKey]: true },
        onUninstall,
        onCancelUninstall,
      }),
    );

    const confirm = container.querySelector<HTMLElement>(".plugins-remove-confirm");
    expect(normalizedText(confirm)).toContain("Remove this plugin package and all of its entries?");
    confirm?.querySelector<HTMLButtonElement>(".btn.danger")?.click();
    expect(onUninstall).toHaveBeenCalledWith("community-thing", rowKey);
    confirm?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    expect(onCancelUninstall).toHaveBeenCalledWith(rowKey);
  });

  it("opens the detail overlay from a row and renders actions and metadata", () => {
    const onShowDetails = vi.fn();
    const clickable = mount(createProps({ onShowDetails }));
    const row = clickable.querySelector<HTMLElement>('[data-plugin-id="workboard"]');
    const detailButton = row?.querySelector<HTMLButtonElement>(".plugins-item__detail-button");
    expect(detailButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton?.type).toBe("button");
    expect(detailButton?.getAttribute("aria-label")).toBe("Workboard");
    detailButton?.focus();
    expect(document.activeElement).toBe(detailButton);
    detailButton?.click();
    expect(onShowDetails).toHaveBeenCalledOnce();
    expect(onShowDetails).toHaveBeenCalledWith("workboard");

    row?.click();
    expect(onShowDetails).toHaveBeenCalledTimes(2);

    const onSetEnabled = vi.fn();
    const container = mount(
      createProps({
        detailPluginId: "workboard",
        onShowDetails,
        onSetEnabled,
      }),
    );
    const detail = container.querySelector<HTMLElement>(".plugins-detail")!;
    expect(detail.closest("openclaw-modal-dialog")?.getAttribute("label")).toBe("Workboard");
    expect(normalizedText(detail.querySelector(".plugins-detail__title"))).toContain("Workboard");
    expect(normalizedText(detail.querySelector(".plugins-detail__meta"))).toContain("workboard");
    detail.querySelectorAll<HTMLButtonElement>(".plugins-detail__actions button")[0]?.click();
    expect(onSetEnabled).toHaveBeenCalledWith("workboard", true, pluginRowKey("workboard"));
    detail.querySelector<HTMLButtonElement>(".plugins-detail__close")?.click();
    expect(onShowDetails).toHaveBeenCalledWith(null);
  });

  it("lists MCP servers with direct toggle and remove plus the add form", () => {
    const onMcpToggle = vi.fn();
    const onMcpRemove = vi.fn();
    const onMcpAdd = vi.fn();
    const container = mount(
      createProps({
        mcpFormOpen: true,
        mcpServers: [
          {
            name: "github",
            enabled: true,
            transport: "streamable-http",
            target: "https://api.githubcopilot.com/mcp/",
            auth: "oauth",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
        onMcpToggle,
        onMcpRemove,
        onMcpAdd,
      }),
    );

    const row = container.querySelector<HTMLElement>('[data-mcp-name="github"]')!;
    expect(normalizedText(row)).toContain("github");
    expect(normalizedText(row)).toContain("OAuth");
    actionButton(row, "Disable")?.click();
    expect(onMcpToggle).toHaveBeenCalledWith("github", false);
    actionButton(row, "Remove github")?.click();
    expect(onMcpRemove).toHaveBeenCalledWith("github");

    const form = container.querySelector<HTMLFormElement>(".mcp-server-form")!;
    form.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "context7";
    form.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value =
      "https://mcp.context7.com/mcp";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onMcpAdd).toHaveBeenCalledWith({
      name: "context7",
      transport: "streamable-http",
      target: "https://mcp.context7.com/mcp",
    });
  });

  it("renders featured and official discover shelves", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "tavily",
        name: "Tavily",
        origin: "official",
        installed: false,
        enabled: false,
        state: "not-installed",
        featured: false,
        install: { source: "official", pluginId: "tavily" },
      }),
    ];
    const onInstall = vi.fn();
    const container = mount(
      createProps({ activeTab: "discover", result: createResult(plugins), onInstall }),
    );
    const featuredHeading =
      [...container.querySelectorAll(".settings-section__heading")].find((heading) =>
        normalizedText(heading).startsWith("Featured"),
      ) ?? null;
    expect(normalizedText(featuredHeading)).toBe("Featured 1");
    container
      .querySelector<HTMLButtonElement>('[data-plugin-id="tavily"] .plugins-install')
      ?.click();
    expect(onInstall).toHaveBeenCalledWith(
      {
        source: "official",
        pluginId: "tavily",
      },
      pluginRowKey("tavily"),
    );
  });

  it("renders featured plugins newest-featured first", () => {
    const plugins = [
      createPlugin({
        id: "not-featured",
        name: "Not Featured",
        featured: false,
        origin: "official",
        installed: false,
        order: 0,
      }),
      createPlugin({
        id: "older-popular",
        name: "Older Popular",
        featured: true,
        featuredAt: 100,
        order: 1,
      }),
      createPlugin({
        id: "newest-featured",
        name: "Newest Featured",
        featured: true,
        featuredAt: 200,
        order: 99,
      }),
    ];

    const container = mount(createProps({ activeTab: "discover", result: createResult(plugins) }));

    expect(
      [...container.querySelectorAll<HTMLElement>("[data-plugin-id]")].map(
        (row) => row.dataset.pluginId,
      ),
    ).toEqual(["newest-featured", "older-popular", "not-featured"]);
  });

  it("adds MCP connectors and routes ClawHub connector searches", () => {
    const onAddConnector = vi.fn();
    const onSearchClawHub = vi.fn();
    const container = mount(
      createProps({ activeTab: "discover", onAddConnector, onSearchClawHub }),
    );

    const github = container.querySelector<HTMLElement>('[data-connector-id="github"]');
    expect(normalizedText(github)).toContain("MCP");
    github?.querySelector<HTMLButtonElement>(".settings-row__control button")?.click();
    expect(onAddConnector).toHaveBeenCalledWith(
      CONNECTOR_SUGGESTIONS.find((connector) => connector.id === "github"),
    );

    const spotify = container.querySelector<HTMLElement>('[data-connector-id="spotify"]');
    spotify?.querySelector<HTMLButtonElement>(".settings-row__control button")?.click();
    expect(onSearchClawHub).toHaveBeenCalledWith("spotify");
  });

  it("marks already-added MCP connectors instead of offering Add", () => {
    const container = mount(
      createProps({
        activeTab: "discover",
        mcpServers: [
          {
            name: "github",
            enabled: true,
            transport: "streamable-http",
            target: "https://x",
            auth: "oauth",
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
      }),
    );

    const github = container.querySelector<HTMLElement>('[data-connector-id="github"]');
    expect(normalizedText(github)).toContain("Added");
    expect(github?.querySelector(".settings-row__control button")).toBeNull();
  });

  it("appends live ClawHub results below the discover shelves while searching", () => {
    const onQueryChange = vi.fn();
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "calendar",
        searchResults: [
          {
            score: 0.9,
            package: {
              name: "@openclaw/calendar-plus",
              displayName: "Calendar Plus",
              family: "code-plugin",
              channel: "official",
              isOfficial: true,
              summary: "Plan and coordinate work.",
              latestVersion: "2.0.0",
              downloads: 149263,
              verificationTier: "source-linked",
            },
          },
        ],
        onQueryChange,
        onInstall,
      }),
    );

    const search = container.querySelector<HTMLInputElement>('[type="search"]');
    search!.value = "work";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onQueryChange).toHaveBeenCalledWith("work");

    const heading =
      [...container.querySelectorAll(".settings-section__heading")].find((candidate) =>
        normalizedText(candidate).startsWith("From ClawHub"),
      ) ?? null;
    expect(normalizedText(heading)).toBe("From ClawHub 1");
    const link = heading
      ?.closest(".settings-section")
      ?.querySelector<HTMLAnchorElement>(".plugins-group__link");
    expect(link?.href).toBe("https://clawhub.ai/plugins");
    expect(link?.target).toBe("_blank");

    const result = container.querySelector<HTMLElement>(
      '[data-package-name="@openclaw/calendar-plus"]',
    );
    expect(result?.dataset.pluginSource).toBe("clawhub");
    expect(normalizedText(result)).toContain("Official");
    expect(normalizedText(result)).toContain("Verified source");
    expect(normalizedText(result)).toContain("149.3K");
    expect(normalizedText(result)).toContain("Code plugin");
    result?.querySelector<HTMLButtonElement>('[aria-label="Install Calendar Plus"]')?.click();
    expect(onInstall).toHaveBeenCalledWith(
      {
        source: "clawhub",
        packageName: "@openclaw/calendar-plus",
      },
      clawHubKey("@openclaw/calendar-plus"),
    );
  });

  it("keeps discovery available while disabling all read-only mutations", () => {
    const onInstall = vi.fn();
    const onSetEnabled = vi.fn();
    const available = createPlugin({
      id: "lobster",
      name: "Lobster",
      installed: false,
      enabled: false,
      state: "not-installed",
      install: { source: "official", pluginId: "lobster" },
    });
    const container = mount(
      createProps({
        activeTab: "discover",
        result: createResult([createPlugin(), available]),
        canMutate: false,
        mutationBlockedReason: "Browsing only. Plugin changes require operator.admin access.",
        onInstall,
        onSetEnabled,
      }),
    );

    expect(container.querySelector(".plugins-readonly")?.textContent).toContain("operator.admin");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Install Lobster"]')?.disabled,
    ).toBe(true);
    const workboardRow = container.querySelector<HTMLElement>('[data-plugin-id="workboard"]')!;
    const enableItem = actionButton(workboardRow, "Enable");
    expect(enableItem?.disabled).toBe(true);
    enableItem?.click();
    expect(onInstall).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it("renders row-local risk acknowledgement and busy state", () => {
    const packageName = "@openclaw/calendar-plus";
    const key = clawHubKey(packageName);
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "calendar",
        searchResults: [
          {
            score: 0.9,
            package: {
              name: packageName,
              displayName: "Calendar Plus",
              family: "bundle-plugin",
              channel: "community",
              isOfficial: false,
            },
          },
        ],
        busy: {},
        messages: {
          [key]: {
            kind: "error",
            text: "Review required.",
            acknowledge: { packageName, version: "2.0.0" },
          },
        },
        onInstall,
      }),
    );

    const row = container.querySelector<HTMLElement>(`[data-package-name="${packageName}"]`);
    expect(row?.getAttribute("aria-busy")).toBe("false");
    expect(row?.querySelector('[role="alert"]')?.textContent).toContain("Review required.");
    row?.querySelector<HTMLButtonElement>(".plugins-row-message button")?.click();
    expect(onInstall).toHaveBeenCalledWith(
      {
        source: "clawhub",
        packageName,
        version: "2.0.0",
        acknowledgeClawHubRisk: true,
      },
      key,
    );
  });

  it("renders install policy findings with cancel and acknowledged retry actions", () => {
    const plugin = createPlugin({
      id: "kitchen-sink",
      name: "OpenClaw Kitchen Sink",
      installed: false,
      enabled: false,
      state: "disabled",
      install: { source: "official", pluginId: "kitchen-sink" },
    });
    const key = pluginRowKey(plugin.id);
    const onInstall = vi.fn();
    const onDismissMessage = vi.fn();
    const onShowDetails = vi.fn();
    const request = { source: "official" as const, pluginId: "kitchen-sink" };
    const container = mount(
      createProps({
        activeTab: "discover",
        result: createResult([plugin]),
        messages: {
          [key]: {
            kind: "warning",
            text: "ClawScan found issues to review.",
            installPolicyWarning: {
              request,
              details: {
                installPolicyCode: "install_policy_warning_acknowledgement_required",
                targetName: "openclaw-kitchen-sink-fixture",
                targetType: "plugin",
                requestMode: "install",
                reason: "ClawScan found issues to review.",
                findings: [
                  {
                    ruleId: "informational-finding",
                    severity: "info",
                    message: "The package declares a network integration.",
                  },
                  {
                    ruleId: "semgrep-finding",
                    severity: "warn",
                    message: "Semgrep found a risky command.",
                    file: "index.ts",
                    line: 12,
                  },
                  {
                    ruleId: "critical-finding",
                    severity: "critical",
                    message: "The package executes an untrusted binary.",
                  },
                ],
              },
            },
          },
        },
        onInstall,
        onDismissMessage,
        onShowDetails,
      }),
    );

    const row = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="kitchen-sink"]'),
      "kitchen sink plugin row",
    );
    const alert = expectDefined(row.querySelector('[role="alert"]'), "install policy warning");
    expect(normalizedText(alert)).toContain("Security review needed");
    expect(normalizedText(alert)).toContain("Policy warnings: 3");
    expect(normalizedText(alert)).toContain("Not installed");
    expect(normalizedText(alert)).toContain(
      "Install anyway approves every install-policy warning encountered during this install",
    );
    expect(normalizedText(alert)).toContain("Findings");
    expect(normalizedText(alert)).toContain("Info The package declares a network integration.");
    expect(normalizedText(alert)).toContain("Warning Semgrep found a risky command.");
    expect(normalizedText(alert)).toContain("Critical The package executes an untrusted binary.");
    expect(normalizedText(alert)).toContain("Semgrep found a risky command.");
    expect(normalizedText(alert.querySelector(".plugins-policy-review__reason"))).toBe(
      "ClawScan found issues to review.",
    );
    const technicalDetails = expectDefined(
      alert.querySelector<HTMLDetailsElement>(".plugins-policy-review__details"),
      "install policy scan details",
    );
    expect(technicalDetails.open).toBe(false);
    expect(normalizedText(technicalDetails.querySelector("summary"))).toBe("Details");
    expect(
      technicalDetails?.querySelector(".plugins-policy-review__details-chevron svg"),
    ).not.toBeNull();
    expect(normalizedText(technicalDetails)).not.toContain("ClawScan found issues to review.");
    expect(normalizedText(technicalDetails)).toContain("semgrep-finding");
    expect(normalizedText(technicalDetails)).toContain("index.ts:12");
    technicalDetails.querySelector("summary")?.click();
    expect(technicalDetails.open).toBe(true);
    expect(onShowDetails).not.toHaveBeenCalled();
    technicalDetails.querySelector<HTMLElement>(".plugins-policy-review__details-body")?.click();
    expect(onShowDetails).not.toHaveBeenCalled();

    actionButton(alert, "Cancel")?.click();
    expect(onDismissMessage).toHaveBeenCalledWith(key);

    actionButton(alert, "Install anyway")?.click();
    expect(onInstall).toHaveBeenCalledWith(
      {
        ...request,
        acknowledgeInstallPolicyWarning: true,
      },
      key,
    );
  });

  it("shares one install-policy review across catalog, search, and detail aliases", () => {
    const plugin = createPlugin({
      id: "lobster",
      name: "Lobster",
      packageName: "@openclaw/lobster",
      installed: false,
      enabled: false,
      state: "disabled",
      install: { source: "official", pluginId: "lobster" },
    });
    const identity = pluginRowKey(plugin.id);
    const request = { source: "official", pluginId: "lobster" } as const;
    const onInstall = vi.fn();
    const onDismissMessage = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "lobster",
        result: createResult([plugin]),
        detailPluginId: plugin.id,
        searchResults: [
          {
            score: 1,
            package: {
              name: "@openclaw/lobster",
              displayName: "Lobster",
              family: "code-plugin",
              channel: "official",
              isOfficial: true,
              runtimeId: "lobster",
            },
          },
        ],
        messages: {
          [identity]: {
            kind: "warning",
            text: "Review this plugin.",
            installPolicyWarning: {
              request,
              details: {
                installPolicyCode: "install_policy_warning_acknowledgement_required",
                targetName: "@openclaw/lobster",
                targetType: "plugin",
                requestMode: "install",
                reason: "Review this plugin.",
              },
            },
          },
        },
        onInstall,
        onDismissMessage,
      }),
    );

    const catalogRow = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="lobster"]'),
      "catalog row",
    );
    const searchRow = expectDefined(
      container.querySelector<HTMLElement>('[data-package-name="@openclaw/lobster"]'),
      "search row",
    );
    const detail = expectDefined(
      container.querySelector<HTMLElement>('[data-detail-plugin-id="lobster"]'),
      "detail",
    );
    for (const surface of [catalogRow, searchRow, detail]) {
      expect(normalizedText(surface.querySelector('[role="alert"]'))).toContain(
        "Review this plugin.",
      );
      expect(actionButton(surface, "Install Lobster")).toBeNull();
    }

    actionButton(searchRow, "Install anyway")?.click();
    expect(onInstall).toHaveBeenCalledWith(
      { ...request, acknowledgeInstallPolicyWarning: true },
      identity,
    );
    actionButton(detail, "Cancel")?.click();
    expect(onDismissMessage).toHaveBeenCalledWith(identity);
  });

  it("preserves a search-only runtime identity when installing", () => {
    const onInstall = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "lobster",
        result: createResult([]),
        searchResults: [
          {
            score: 1,
            package: {
              name: "@openclaw/lobster",
              displayName: "Lobster",
              family: "code-plugin",
              channel: "official",
              isOfficial: true,
              runtimeId: "lobster",
            },
          },
        ],
        onInstall,
      }),
    );

    actionButton(container, "Install Lobster")?.click();
    expect(onInstall).toHaveBeenCalledWith(
      { source: "clawhub", packageName: "@openclaw/lobster" },
      "plugin:lobster",
    );
  });

  it("keeps the not-installed outcome visible for reason-only policy warnings", () => {
    const plugin = createPlugin({
      id: "reason-only",
      name: "Reason Only",
      installed: false,
      enabled: false,
      state: "disabled",
      install: { source: "official", pluginId: "reason-only" },
    });
    const key = pluginRowKey(plugin.id);
    const container = mount(
      createProps({
        activeTab: "discover",
        result: createResult([plugin]),
        messages: {
          [key]: {
            kind: "warning",
            text: "Review this package source.",
            installPolicyWarning: {
              request: { source: "official", pluginId: "reason-only" },
              details: {
                installPolicyCode: "install_policy_warning_acknowledgement_required",
                targetName: "reason-only",
                targetType: "plugin",
                requestMode: "install",
                reason: "Review this package source.",
              },
            },
          },
        },
      }),
    );

    const alert = expectDefined(
      container.querySelector('[data-plugin-id="reason-only"] [role="alert"]'),
      "reason-only install policy warning",
    );
    expect(normalizedText(alert)).toContain("Review this package source. Not installed.");
  });

  it("correlates installed ClawHub packages without a search runtime id", () => {
    const packageName = "@community/calendar-plus";
    const installed = createPlugin({
      id: "calendar-runtime",
      name: "Calendar Plus",
      packageName,
      origin: "global",
      installed: true,
      enabled: true,
      state: "enabled",
      featured: false,
      install: undefined,
    });
    const onSetEnabled = vi.fn();
    const onShowDetails = vi.fn();
    const container = mount(
      createProps({
        activeTab: "discover",
        query: "calendar",
        result: createResult([installed]),
        searchResults: [
          {
            score: 0.9,
            package: {
              name: packageName,
              displayName: "Calendar Plus",
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
            },
          },
        ],
        onSetEnabled,
        onShowDetails,
      }),
    );

    const row = container.querySelector<HTMLElement>(`[data-package-name="${packageName}"]`)!;
    expect(normalizedText(row.querySelector(".settings-row__title"))).toBe("Calendar Plus");
    expect(row.querySelector(".plugins-install")).toBeNull();
    actionButton(row, "Disable")?.click();
    expect(onSetEnabled).toHaveBeenCalledWith("calendar-runtime", false, clawHubKey(packageName));
    expect(onShowDetails).not.toHaveBeenCalled();
    const detailButton = row.querySelector<HTMLButtonElement>(".plugins-item__detail-button");
    expect(detailButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton?.getAttribute("aria-label")).toBe("Calendar Plus");
    detailButton?.click();
    expect(onShowDetails).toHaveBeenCalledOnce();
    expect(onShowDetails).toHaveBeenCalledWith("calendar-runtime");
  });

  it("does not present an empty catalog alongside an initial list failure", () => {
    const container = mount(createProps({ result: null, error: "Plugin inventory unavailable" }));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Plugin inventory unavailable",
    );
    expect(container.textContent).not.toContain("No optional plugins installed");
  });

  it("renders bundled art tiles in discover and gradient fallbacks elsewhere", () => {
    const plugins = [
      createPlugin(),
      createPlugin({
        id: "totally-unknown",
        name: "Totally Unknown",
        featured: true,
        origin: "official",
        installed: false,
        state: "not-installed",
      }),
    ];
    const container = mount(createProps({ activeTab: "discover", result: createResult(plugins) }));

    const art = container.querySelector<HTMLImageElement>(
      '[data-plugin-id="workboard"] .plugins-tile img',
    );
    expect(art?.src).toContain("plugin-art/workboard.webp");

    const fallback = container.querySelector<HTMLElement>(
      '[data-plugin-id="totally-unknown"] .plugins-tile--fallback',
    );
    expect(fallback?.getAttribute("style")).toContain("--plugins-art-a");
    expect(normalizedText(fallback)).toBe("TU");
  });
});
