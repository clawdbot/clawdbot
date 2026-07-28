const PANEL_PATH = "sidepanel.html";

function parsePanelBindingUrl(chromeApi, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const token = url.searchParams.get("binding");
  if (
    url.protocol !== "chrome-extension:" ||
    url.host !== chromeApi.runtime.id ||
    !url.pathname.endsWith(`/${PANEL_PATH}`) ||
    !token ||
    [...url.searchParams].length !== 1 ||
    url.hash
  ) {
    return null;
  }
  return { token, url: url.toString() };
}

export async function resolveSidePanelTabId(chromeApi, port, panelBindings) {
  const binding = parsePanelBindingUrl(chromeApi, port.sender?.url);
  if (!binding) {
    throw new Error("Copilot is available only in a tab-specific side panel.");
  }
  const tabId = await panelBindings.resolve(binding.token);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("This panel does not hold a live tab binding.");
  }
  const contexts = await chromeApi.runtime.getContexts({
    contextTypes: ["SIDE_PANEL"],
  });
  const documentId = port.sender?.documentId;
  // Chrome reports tabId=-1 for SIDE_PANEL contexts. The unguessable URL maps
  // to the tab; this live-context check prevents a normal extension page from claiming it.
  const context = contexts.find(
    (candidate) =>
      candidate.contextType === "SIDE_PANEL" &&
      candidate.documentUrl === binding.url &&
      (typeof documentId !== "string" || candidate.documentId === documentId),
  );
  if (!context) {
    throw new Error("Chrome did not bind this panel to a tab.");
  }
  return tabId;
}

export async function archiveCopilotSession(gateway, entry) {
  if (entry.ensureCreated) {
    // The worker may have stopped after persisting creation intent but before
    // sending it. sessions.create adopts the same key, making cleanup idempotent.
    await gateway.request("sessions.create", {
      key: entry.sessionKey,
      label: "Browser copilot",
    });
  }
  try {
    await gateway.request("sessions.messages.unsubscribe", { key: entry.sessionKey });
  } catch {
    // The allowlist is connection-local. A closed socket already stopped delivery.
  }
  try {
    await gateway.request("sessions.abort", { key: entry.sessionKey });
  } catch {
    // Archive is authoritative; it will reject while a run is still active and retry later.
  }
  await gateway.request("sessions.patch", { key: entry.sessionKey, archived: true });
}

export function selectCopilotPanelState({ paired, shared, abortPending, gatewayState }) {
  if (!paired) {
    return "needs-pairing";
  }
  if (!shared) {
    return "needs-sharing";
  }
  return abortPending ? "reconciling" : gatewayState;
}

export function sessionKeyFromEvent(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return typeof payload.sessionKey === "string" ? payload.sessionKey : null;
}

function isLoopbackUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function resolveBindingTarget(config) {
  try {
    const relay = new URL(config.relayUrl);
    if (relay.pathname.endsWith("/browser/extension")) {
      return "host";
    }
    if (isLoopbackUrl(config.relayUrl) && isLoopbackUrl(config.gatewayUrl)) {
      return "host";
    }
  } catch {
    // Fall through to the explicit topology denial below.
  }
  throw new Error(
    "Copilot needs a direct Gateway relay. Browser-node routing is not yet supported.",
  );
}

export function safeTabLabel(tab) {
  try {
    const url = new URL(tab.url ?? "");
    return url.hostname || url.protocol.replace(":", "") || "Browser tab";
  } catch {
    return "Browser tab";
  }
}

export { PANEL_PATH };
