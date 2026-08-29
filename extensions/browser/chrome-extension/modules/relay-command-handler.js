/** Build the authenticated application-command dispatcher for the relay socket. */
export function createRelayCommandHandler({
  send,
  isCurrent,
  attachDebugger,
  detachDebugger,
  createTab,
  focusWindowForTab,
  scheduleTabsSync,
  captureAccess,
  requireAccessibleTab,
  requireNavigatedTab,
  navigateTab,
}) {
  return async (message) => {
    const { seq } = message;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new Error("relay connection was replaced or closed");
      }
    };
    const reply = (frame) => {
      assertCurrent();
      send(frame);
    };
    const requireTab = async (tabId, epoch, check = requireAccessibleTab) => {
      assertCurrent();
      const tab = await check(tabId, epoch);
      assertCurrent();
      return tab;
    };
    try {
      assertCurrent();
      switch (message.type) {
        case "ping":
          reply({ type: "pong" });
          return;
        case "attach":
          reply({
            type: "result",
            seq,
            result: await attachDebugger(message.tabId, assertCurrent),
          });
          return;
        case "detach":
          await detachDebugger(message.tabId);
          reply({ type: "result", seq, result: {} });
          return;
        case "cdp": {
          const epoch = captureAccess(message.tabId, message.method);
          await requireTab(message.tabId, epoch);
          const target = message.sessionId
            ? { tabId: message.tabId, sessionId: message.sessionId }
            : { tabId: message.tabId };
          const sendCommand = (method, params) =>
            chrome.debugger.sendCommand(target, method, params);
          const controlledBlank =
            !message.sessionId &&
            message.method === "Page.navigate" &&
            message.params?.url === "about:blank";
          const result = controlledBlank
            ? await navigateTab(message.tabId, epoch, message.params, isCurrent, sendCommand)
            : await sendCommand(message.method, message.params ?? {});
          await requireTab(
            message.tabId,
            epoch,
            controlledBlank ? requireNavigatedTab : requireAccessibleTab,
          );
          reply({ type: "result", seq, result: result ?? {} });
          return;
        }
        case "createTab": {
          await createTab(message, {
            isCurrent,
            attachDebugger,
            handoff: (result) => reply({ type: "result", seq, result }),
          });
          scheduleTabsSync();
          return;
        }
        case "closeTab": {
          const epoch = captureAccess(message.tabId);
          await requireTab(message.tabId, epoch);
          // Chrome closes the debugger with the tab. Detaching first would retire
          // the controlled document's authority before its explicit close can run.
          await chrome.tabs.remove(message.tabId);
          reply({ type: "result", seq, result: {} });
          return;
        }
        case "activateTab": {
          const epoch = captureAccess(message.tabId);
          const tab = await requireTab(message.tabId, epoch);
          await chrome.tabs.update(message.tabId, { active: true });
          await requireTab(message.tabId, epoch);
          await focusWindowForTab(tab);
          await requireTab(message.tabId, epoch);
          reply({ type: "result", seq, result: {} });
          return;
        }
        default:
          if (typeof seq === "number") {
            reply({ type: "error", seq, message: `unknown relay command: ${message.type}` });
          }
      }
    } catch (error) {
      if (typeof seq === "number" && isCurrent()) {
        send({
          type: "error",
          seq,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
