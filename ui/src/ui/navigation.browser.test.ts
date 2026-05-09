import { describe, expect, it, vi } from "vitest";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

function mountApp(pathname: string) {
  return mountTestApp(pathname);
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function expectElement<T extends Element>(
  root: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = root.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

function expectButtonWithText(app: ReturnType<typeof mountApp>, text: string): HTMLButtonElement {
  const button = Array.from(app.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

async function confirmPendingGatewayChange(app: ReturnType<typeof mountApp>) {
  const confirmButton = expectButtonWithText(app, "Confirm");
  confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await app.updateComplete;
}

function expectConfirmedGatewayChange(app: ReturnType<typeof mountApp>) {
  expect(app.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
  expect(app.settings.token).toBe("abc123");
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("");
}

describe("control UI routing", () => {
  it("renders responsive navigation shell, drawer, and collapsed states", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    expectElement(app, 'a.nav-item[href="/dreaming"]', HTMLAnchorElement);
  });

  it("renders the dashboard breadcrumb as an overview link", async () => {
    const app = mountApp("/channels");
    await app.updateComplete;

    const breadcrumb = expectElement(
      app,
      "dashboard-header .dashboard-header__breadcrumb-link",
      HTMLAnchorElement,
    );
    expect(breadcrumb.getAttribute("href")).toBe("/overview");

    breadcrumb.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.tab).toBe("overview");
    expect(window.location.pathname).toBe("/overview");
  });

  it("keeps the dashboard breadcrumb link inside the configured base path", async () => {
    const app = mountApp("/ui/channels");
    await app.updateComplete;

    const breadcrumb = expectElement(
      app,
      "dashboard-header .dashboard-header__breadcrumb-link",
      HTMLAnchorElement,
    );
    expect(breadcrumb.getAttribute("href")).toBe("/ui/overview");
  });

  it("renders the dreaming view on the /dreaming route", async () => {
    const app = mountApp("/dreaming");
    app.dreamingStatus = {
      enabled: true,
      timezone: "Europe/Madrid",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 2,
      recallSignalCount: 1,
      dailySignalCount: 1,
      groundedSignalCount: 0,
      totalSignalCount: 2,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 1,
      promotedToday: 1,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { enabled: true, cron: "", managedCronPresent: false, lookbackDays: 7, limit: 20 },
        deep: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          limit: 20,
          minScore: 0.75,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          lookbackDays: 7,
          limit: 20,
          minPatternStrength: 0.6,
        },
      },
    };
    app.dreamDiaryPath = "DREAMS.md";
    app.dreamDiaryContent = [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "",
      "---",
      "",
      "*January 1, 2026*",
      "",
      "What Happened",
      "1. Stable operator rule surfaced.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
    ].join("\n");
    app.requestUpdate();
    await app.updateComplete;

    expect(app.tab).toBe("dreams");
    expectElement(app, ".dreams__tab", HTMLElement);
    expectElement(app, ".dreams__lobster", HTMLElement);
  });

  it("requires confirmation before sending dreaming restart patch", async () => {
    const app = mountApp("/dreaming");
    const request = vi.fn(async (method: string) => {
      if (method === "config.schema.lookup") {
        return {
          schema: {
            additionalProperties: true,
          },
          children: [{ key: "dreaming" }],
        };
      }
      if (method === "config.patch") {
        return { ok: true };
      }
      if (method === "config.get") {
        return {
          hash: "hash-2",
          config: {
            plugins: {
              slots: {
                memory: "memory-core",
              },
              entries: {
                "memory-core": {
                  config: {
                    dreaming: {
                      enabled: true,
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (method === "doctor.memory.status") {
        return {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            verboseLogging: false,
            storageMode: "inline",
            separateReports: false,
            shortTermCount: 0,
            recallSignalCount: 0,
            dailySignalCount: 0,
            groundedSignalCount: 0,
            totalSignalCount: 0,
            phaseSignalCount: 0,
            lightPhaseHitCount: 0,
            remPhaseHitCount: 0,
            promotedTotal: 0,
            promotedToday: 0,
            shortTermEntries: [],
            signalEntries: [],
            promotedEntries: [],
            phases: {
              light: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 7,
                limit: 20,
              },
              deep: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                limit: 20,
                minScore: 0.75,
                minRecallCount: 3,
                minUniqueQueries: 2,
                recencyHalfLifeDays: 7,
              },
              rem: {
                enabled: true,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 7,
                limit: 20,
                minPatternStrength: 0.6,
              },
            },
          },
        };
      }
      return {};
    });

    app.client = {
      request,
      stop: vi.fn(),
    } as unknown as NonNullable<typeof app.client>;
    app.connected = true;
    app.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    };
    app.dreamingStatus = {
      enabled: true,
      timezone: "UTC",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      groundedSignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { enabled: true, cron: "", managedCronPresent: false, lookbackDays: 7, limit: 20 },
        deep: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          limit: 20,
          minScore: 0.75,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          lookbackDays: 7,
          limit: 20,
          minPatternStrength: 0.6,
        },
      },
    };
    app.requestUpdate();
    await app.updateComplete;

    const toggle = expectElement(app, ".dreams__phase-toggle--on", HTMLButtonElement);
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(request).not.toHaveBeenCalledWith("config.patch", expect.anything());
    const confirmRestart = expectButtonWithText(app, "Confirm Restart");
    confirmRestart.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await nextFrame();
    await app.updateComplete;

    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "hash-1",
      }),
    );
  });

  it("renders the refreshed top navigation shell", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expectElement(app, ".topnav-shell", HTMLElement);
    expectElement(app, ".topnav-shell__content", HTMLElement);
    expectElement(app, ".topnav-shell__actions", HTMLElement);
    expect(app.querySelector(".topnav-shell .brand-title")).toBeNull();

    expectElement(app, ".sidebar-shell", HTMLElement);
    expectElement(app, ".sidebar-shell__header", HTMLElement);
    expectElement(app, ".sidebar-shell__body", HTMLElement);
    expectElement(app, ".sidebar-shell__footer", HTMLElement);
    expectElement(app, ".sidebar-brand", HTMLElement);
    expectElement(app, ".sidebar-brand__logo", HTMLElement);
    expectElement(app, ".sidebar-brand__copy", HTMLElement);

    app.hello = {
      ok: true,
      server: { version: "1.2.3" },
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    expectElement(app, ".sidebar-version", HTMLElement);
    const statusDot = expectElement(app, ".sidebar-version__status", HTMLElement);
    expect(statusDot.getAttribute("aria-label")).toContain("Online");

    app.applySettings({ ...app.settings, navWidth: 360 });
    await app.updateComplete;

    expect(app.querySelector(".sidebar-resizer")).toBeNull();
    const shell = expectElement(app, ".shell", HTMLElement);
    expect(shell.style.getPropertyValue("--shell-nav-width")).toBe("");

    const split = expectElement(app, ".chat-split-container", HTMLElement);
    split.classList.add("chat-split-container--open");
    await app.updateComplete;
    expect(split.classList.contains("chat-split-container--open")).toBe(true);

    expectElement(app, ".chat-main", HTMLElement);

    const topShell = expectElement(app, ".topnav-shell", HTMLElement);
    const content = expectElement(app, ".topnav-shell__content", HTMLElement);

    expect(topShell.classList.contains("topnav-shell")).toBe(true);
    expect(content.classList.contains("topnav-shell__content")).toBe(true);
    expectElement(topShell, ".topbar-nav-toggle", HTMLElement);
    expect(topShell.children[1]).toBe(content);
    expectElement(topShell, ".topnav-shell__actions", HTMLElement);

    const toggle = expectElement(app, ".topbar-nav-toggle", HTMLElement);
    const actions = expectElement(app, ".topnav-shell__actions", HTMLElement);

    expect(toggle.classList.contains("topbar-nav-toggle")).toBe(true);
    expect(toggle.classList.contains("sidebar-menu-trigger")).toBe(true);
    expect(actions.classList.contains("topnav-shell__actions")).toBe(true);
    expect(topShell.firstElementChild).toBe(toggle);
    expect(topShell.querySelector(".topbar-nav-toggle")).toBe(toggle);
    expectElement(actions, ".topbar-search", HTMLElement);
    expect(toggle.getAttribute("aria-label")).toEqual(expect.stringMatching(/\S/u));

    const nav = expectElement(app, ".shell-nav", HTMLElement);

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(false);
    toggle.click();
    await app.updateComplete;

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(true);
    expect(nav.classList.contains("shell-nav")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const link = expectElement(app, 'a.nav-item[href="/channels"]', HTMLAnchorElement);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(false);

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".nav-section__label")).toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).toBeNull();

    expectElement(app, ".sidebar-shell__footer", HTMLElement);
    expectElement(app, ".sidebar-utility-link", HTMLElement);

    const item = expectElement(app, ".sidebar .nav-item", HTMLElement);
    const header = expectElement(app, ".sidebar-shell__header", HTMLElement);
    const sidebar = expectElement(app, ".sidebar", HTMLElement);

    expect(sidebar.classList.contains("sidebar--collapsed")).toBe(true);
    expectElement(item, ".nav-item__icon", HTMLElement);
    expect(item.querySelector(".nav-item__text")).toBeNull();
    expect(app.querySelector(".sidebar-brand__copy")).toBeNull();
    expectElement(header, ".nav-collapse-toggle", HTMLElement);
  });

  it("closes mobile chat controls on Escape, outside pointerdown, and tab changes", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const toggle = expectElement(app, ".chat-controls-mobile-toggle", HTMLButtonElement);
    const dropdown = expectElement(app, ".chat-controls-dropdown", HTMLElement);

    toggle.focus();
    toggle.click();
    await app.updateComplete;

    expect(app.chatMobileControlsOpen).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dropdown.classList.contains("open")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await app.updateComplete;
    await nextFrame();

    expect(app.chatMobileControlsOpen).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(toggle);

    toggle.click();
    await app.updateComplete;
    app.requestUpdate();
    await app.updateComplete;

    const openDropdown = app.querySelector<HTMLElement>(".chat-controls-dropdown");
    expect(app.chatMobileControlsOpen).toBe(true);
    expect(openDropdown?.classList.contains("open")).toBe(true);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await app.updateComplete;

    const closedDropdown = app.querySelector<HTMLElement>(".chat-controls-dropdown");
    expect(app.chatMobileControlsOpen).toBe(false);
    expect(closedDropdown?.classList.contains("open")).toBe(false);

    expectElement(app, ".chat-controls-mobile-toggle", HTMLButtonElement).click();
    await app.updateComplete;
    expect(app.chatMobileControlsOpen).toBe(true);

    app.setTab("channels");
    await app.updateComplete;
    expect(app.chatMobileControlsOpen).toBe(false);
  });

  it("preserves session navigation and keeps focus mode scoped to chat", async () => {
    const app = mountApp("/sessions?session=agent:main:subagent:task-123");
    await app.updateComplete;

    const link = expectElement(app, 'a.nav-item[href="/chat"]', HTMLAnchorElement);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe("agent:main:subagent:task-123");
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?session=agent%3Amain%3Asubagent%3Atask-123");

    const shell = expectElement(app, ".shell", HTMLElement);
    expect(shell.classList.contains("shell--chat-focus")).toBe(false);

    const toggle = expectElement(app, 'button[title^="Toggle focus mode"]', HTMLButtonElement);
    toggle.click();

    await app.updateComplete;
    expect(shell.classList.contains("shell--chat-focus")).toBe(true);

    const channelsLink = expectElement(app, 'a.nav-item[href="/channels"]', HTMLAnchorElement);
    channelsLink.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(shell.classList.contains("shell--chat-focus")).toBe(false);

    const chatLink = expectElement(app, 'a.nav-item[href="/chat"]', HTMLAnchorElement);
    chatLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(shell.classList.contains("shell--chat-focus")).toBe(true);
  });

  it("auto-scrolls chat history to the latest message", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer = app.querySelector<HTMLElement>(".chat-thread");
    expect(initialContainer).toBeInstanceOf(HTMLElement);
    const initialThread = initialContainer!;
    initialThread.style.maxHeight = "180px";
    initialThread.style.overflow = "auto";
    let scrollTop = 0;
    Object.defineProperty(initialThread, "clientHeight", {
      configurable: true,
      get: () => 180,
    });
    Object.defineProperty(initialThread, "scrollHeight", {
      configurable: true,
      get: () => 2400,
    });
    Object.defineProperty(initialThread, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    initialThread.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      const top =
        typeof options === "number" ? (y ?? 0) : typeof options?.top === "number" ? options.top : 0;
      scrollTop = Math.max(0, Math.min(top, 2400 - 180));
    }) as typeof initialThread.scrollTo;

    app.chatMessages = Array.from({ length: 3 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index}`,
      timestamp: Date.now() + index,
    }));

    await app.updateComplete;
    for (let i = 0; i < 6; i++) {
      await nextFrame();
    }

    const container = app.querySelector<HTMLElement>(".chat-thread");
    expect(container).toBeInstanceOf(HTMLElement);
    const thread = container!;
    let finalScrollTop = 0;
    Object.defineProperty(thread, "clientHeight", {
      value: 180,
      configurable: true,
    });
    Object.defineProperty(thread, "scrollHeight", {
      value: 960,
      configurable: true,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      get: () => finalScrollTop,
      set: (value: number) => {
        finalScrollTop = value;
      },
    });
    Object.defineProperty(thread, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number }) => {
        finalScrollTop = top;
      },
    });
    const targetScrollTop = thread.scrollHeight;
    expect(targetScrollTop).toBeGreaterThan(thread.clientHeight);
    app.chatMessages = [
      ...app.chatMessages,
      {
        role: "assistant",
        content: "Line 3",
        timestamp: Date.now() + 3,
      },
    ];
    await app.updateComplete;
    for (let i = 0; i < 10; i++) {
      if (thread.scrollTop === targetScrollTop) {
        break;
      }
      await nextFrame();
    }
    expect(thread.scrollTop).toBe(targetScrollTop);
  });

  it("hydrates hash tokens, restores same-tab refreshes, and clears after gateway changes", async () => {
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.hash).toBe("");
    app.remove();

    const refreshed = mountApp("/ui/overview");
    await refreshed.updateComplete;

    expect(refreshed.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );

    const gatewayUrlInput = expectElement(
      refreshed,
      'input[placeholder="ws://100.x.y.z:18789"]',
      HTMLInputElement,
    );
    gatewayUrlInput.value = "wss://other-gateway.example/openclaw";
    gatewayUrlInput.dispatchEvent(new Event("input", { bubbles: true }));
    await refreshed.updateComplete;

    expect(refreshed.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(refreshed.settings.token).toBe("");
  });

  it("keeps a hash token pending until the gateway URL change is confirmed", async () => {
    const app = mountApp(
      "/ui/overview?gatewayUrl=wss://other-gateway.example/openclaw#token=abc123",
    );
    await app.updateComplete;

    expect(app.settings.gatewayUrl).not.toBe("wss://other-gateway.example/openclaw");
    expect(app.settings.token).toBe("");

    await confirmPendingGatewayChange(app);

    expectConfirmedGatewayChange(app);
  });
});
