import { requireSharedTab } from "./relay-tab-groups.js";

/** Build the authenticated application-command dispatcher for the relay socket. */
export function createRelayCommandHandler({
  send,
  attachDebugger,
  detachDebugger,
  addTabToOpenClawGroup,
  focusWindowForTab,
  scheduleTabsSync,
}) {
  return async (message) => {
    const { seq } = message;
    try {
      switch (message.type) {
        case "ping":
          send({ type: "pong" });
          return;
        case "attach":
          send({ type: "result", seq, result: await attachDebugger(message.tabId) });
          return;
        case "detach":
          await detachDebugger(message.tabId);
          send({ type: "result", seq, result: {} });
          return;
        case "cdp": {
          await requireSharedTab(message.tabId);
          const target = message.sessionId
            ? { tabId: message.tabId, sessionId: message.sessionId }
            : { tabId: message.tabId };
          const result = await chrome.debugger.sendCommand(
            target,
            message.method,
            message.params ?? {},
          );
          send({ type: "result", seq, result: result ?? {} });
          return;
        }
        case "createTab": {
          const tab = await chrome.tabs.create({
            url: message.url,
            active: message.background !== true,
          });
          await addTabToOpenClawGroup(tab.id);
          if (message.focus === true) {
            await focusWindowForTab(tab);
          }
          scheduleTabsSync();
          send({ type: "result", seq, result: { tabId: tab.id } });
          return;
        }
        case "closeTab":
          await requireSharedTab(message.tabId);
          await detachDebugger(message.tabId);
          await requireSharedTab(message.tabId);
          await chrome.tabs.remove(message.tabId);
          send({ type: "result", seq, result: {} });
          return;
        case "activateTab": {
          const tab = await requireSharedTab(message.tabId);
          await chrome.tabs.update(message.tabId, { active: true });
          await requireSharedTab(message.tabId);
          await focusWindowForTab(tab);
          send({ type: "result", seq, result: {} });
          return;
        }
        default:
          if (typeof seq === "number") {
            send({ type: "error", seq, message: `unknown relay command: ${message.type}` });
          }
      }
    } catch (error) {
      if (typeof seq === "number") {
        send({
          type: "error",
          seq,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
