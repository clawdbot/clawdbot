import { buildPageSharePayload, capturePageShare } from "./page-share-core.js";

/** Own popup/command/context-menu page sharing and its transient badge. */
export function createPageShareController({
  chromeApi = chrome,
  ensureRelayReady,
  sendPageShareRequest,
  restoreBadge,
}) {
  let badgeTimer = null;

  function flashBadge(ok) {
    if (badgeTimer) {
      clearTimeout(badgeTimer);
    }
    void chromeApi.action.setBadgeText({ text: ok ? "✓" : "!" });
    void chromeApi.action.setBadgeBackgroundColor({ color: ok ? "#0F9D58" : "#B91C1C" });
    badgeTimer = setTimeout(
      () => {
        badgeTimer = null;
        restoreBadge();
      },
      ok ? 2_000 : 3_000,
    );
  }

  async function sendPage(tabId, note) {
    await ensureRelayReady();
    const tab = await chromeApi.tabs.get(tabId);
    const capture = await capturePageShare(tab);
    const payload = buildPageSharePayload({ ...capture, note });
    if (!payload.content && !payload.selection) {
      throw new Error("Nothing to send on this page.");
    }
    await sendPageShareRequest(payload);
  }

  async function sendSelectionSnapshot(tab, selection) {
    await ensureRelayReady();
    await sendPageShareRequest(
      buildPageSharePayload({
        url: tab.url ?? "",
        title: tab.title ?? "",
        content: "",
        selection,
        note: "",
      }),
    );
  }

  function withBadge(promise) {
    return promise.then(
      () => flashBadge(true),
      () => flashBadge(false),
    );
  }

  async function installContextMenu() {
    await chromeApi.contextMenus.removeAll();
    chromeApi.contextMenus.create({
      id: "openclaw-send-page",
      title: "Send page to OpenClaw",
      contexts: ["page", "selection"],
    });
  }

  chromeApi.commands.onCommand.addListener((command) => {
    if (command !== "send-page") {
      return;
    }
    void chromeApi.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => (typeof tab?.id === "number" ? withBadge(sendPage(tab.id, "")) : undefined));
  });
  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "openclaw-send-page" || typeof tab?.id !== "number") {
      return;
    }
    const selection = info.selectionText?.trim() ?? "";
    void withBadge(selection ? sendSelectionSnapshot(tab, selection) : sendPage(tab.id, ""));
  });

  return { installContextMenu, sendPage };
}
