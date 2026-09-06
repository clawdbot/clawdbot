/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { createApplicationOverlays } from "../app/overlays.ts";
import { updateRunHarness } from "../app/update-run.test-support.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import {
  renderSidebarIssueItem,
  renderSidebarMentionItem,
  renderSidebarUpdateSurface,
} from "./sidebar-issue-item.ts";

const item: SidebarAttentionItem = {
  type: "attention",
  category: "automations",
  dismissal: null,
  requiresAction: true,
  kind: "cronFailed",
  severity: "error",
  icon: "clock",
  label: "Nightly backup",
  detail: "Failed now",
  action: { kind: "navigate", routeId: "cron" },
  signature: "backup",
};

const container = document.createElement("div");

afterEach(() => {
  render(null, container);
});

describe("renderSidebarIssueItem", () => {
  it("renders a dismiss control only when the producer supplies the action", () => {
    const shared = {
      basePath: "",
      onNavigate: vi.fn(),
      onOpen: vi.fn(),
    };
    render(renderSidebarIssueItem(item, shared), container);
    expect(container.querySelector(".sidebar-issues-panel__dismiss")).toBeNull();

    const onDismiss = vi.fn();
    render(renderSidebarIssueItem(item, { ...shared, onDismiss }), container);
    container.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("renderSidebarMentionItem", () => {
  const mention: MentionInboxItem = {
    id: "mention-riley",
    senderProfileId: "profile-riley",
    senderLabel: "Riley",
    sessionKey: "agent:writer:chat:12345678-90ab-cdef-1234-567890abcdef",
    agentId: "writer",
    sessionTitle: "Release notes",
    messageId: "message-1",
    createdAt: 1_780_000_000_000,
    expiresAt: 1_780_003_600_000,
    excerpt: "Can you review the release notes?",
  };
  const pathname = "/team/chat/writer/chat/12345678-90ab-cdef-1234-567890abcdef";
  const navigation = {
    pathname,
    search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(mention.sessionKey)}`,
  };

  function renderMention(overrides: Partial<Parameters<typeof renderSidebarMentionItem>[0]> = {}) {
    const params = {
      mention,
      context: { basePath: "/team", navigate: vi.fn() },
      dismissing: false,
      onDismiss: vi.fn(),
      onClosePanel: vi.fn(),
      ...overrides,
    };
    render(renderSidebarMentionItem(params), container);
    return params;
  }

  it("opens the linked session without dismissing the mention", () => {
    const { context, onClosePanel, onDismiss } = renderMention();
    const open = container.querySelector<HTMLAnchorElement>("a[data-issue-row-focus]")!;
    expect(open.getAttribute("href")).toBe(pathname);

    let nativeNavigationPreserved = false;
    open.addEventListener(
      "click",
      (event) => {
        nativeNavigationPreserved = !event.defaultPrevented;
        // Observe the renderer's native-link behavior without navigating jsdom.
        event.preventDefault();
      },
      { once: true },
    );
    open.dispatchEvent(new MouseEvent("click", { metaKey: true, cancelable: true }));
    expect(nativeNavigationPreserved).toBe(true);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(onClosePanel).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    open.click();
    expect(context.navigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
    expect(onClosePanel).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>("[data-mention-id] button")!.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(context.navigate).toHaveBeenCalledOnce();
    expect(onClosePanel).toHaveBeenCalledOnce();
  });

  it("renders the message excerpt as text rather than HTML or Markdown", () => {
    const excerpt = '<img src="about:blank" onerror="alert(1)"> & **release notes**';
    renderMention({ mention: { ...mention, excerpt } });

    const renderedExcerpt = container.querySelector(".sidebar-mention-row__excerpt")!;
    expect(renderedExcerpt.textContent).toBe(excerpt);
    expect(renderedExcerpt.children).toHaveLength(0);
  });

  it("disables repeated dismissal while leaving the session link usable", () => {
    const { context, onClosePanel, onDismiss } = renderMention({ dismissing: true });
    const dismiss = container.querySelector<HTMLButtonElement>("[data-mention-id] button")!;
    expect(dismiss.disabled).toBe(true);
    dismiss.click();
    expect(onDismiss).not.toHaveBeenCalled();

    container.querySelector<HTMLAnchorElement>("a[data-issue-row-focus]")!.click();
    expect(context.navigate).toHaveBeenCalledExactlyOnceWith("chat", navigation);
    expect(onClosePanel).toHaveBeenCalledOnce();
  });
});

describe("renderSidebarUpdateSurface", () => {
  beforeEach(() => {
    document.body.append(container);
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each(["acknowledged", "expired", "visible"] as const)(
    "dismisses the producer's current notice beside a %s terminal run",
    async (state) => {
      const run = createUpdateRunFixture({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: Date.now() - (state === "expired" ? 25 * 60 * 60 * 1_000 : 0),
      });
      const harness = updateRunHarness(async () => ({
        lastRun: run,
        updateAvailable: { currentVersion: "2.0.0", latestVersion: "3.0.0", channel: "stable" },
      }));
      harness.update({
        hello: {
          ...harness.gateway.snapshot.hello!,
          server: { version: "2.0.0", bootId: "fixture-boot" },
          features: { methods: ["update.run", "update.status"] },
        },
      });
      const overlays = createApplicationOverlays(harness.gateway);
      const context = { gateway: harness.gateway, overlays };
      try {
        await overlays.refreshUpdateStatus();
        if (state === "acknowledged") {
          overlays.acknowledgeUpdateRun();
        }
        const dismissal = resolveSidebarUpdateAttention(context).dismissal;
        const expected = {
          kind: "updateAvailable",
          signature: JSON.stringify(
            state === "visible" ? ["run", run.runId] : ["3.0.0", "fixture-boot"],
          ),
        };
        const dismiss = vi.fn();
        render(
          renderSidebarUpdateSurface({
            context,
            onDismiss: () => dismiss(dismissal),
            onNavigate: vi.fn(),
            visible: true,
            watchUpdateProgress: undefined,
          }),
          container,
        );
        const card = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-sidebar-update-card",
        )!;
        await card.updateComplete;
        expect(container.textContent).toContain(state === "visible" ? "OpenClaw updated" : "3.0.0");
        container.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")!.click();
        expect(dismiss).toHaveBeenCalledExactlyOnceWith(expected);
        expect(overlays.snapshot.updateRunAcknowledged).toBe(state === "acknowledged");
      } finally {
        overlays.dispose();
      }
    },
  );
});
