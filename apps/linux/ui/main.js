const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  activity: document.querySelector("#activity"),
  activityLabel: document.querySelector("#activity-label"),
  actionControls: document.querySelector("#action-controls"),
  channel: document.querySelector("#channel"),
  description: document.querySelector("#description"),
  eyebrow: document.querySelector("#eyebrow"),
  gatewayList: document.querySelector("#gateway-list"),
  discoveryStatus: document.querySelector("#discovery-status"),
  installButton: document.querySelector("#install-button"),
  installControls: document.querySelector("#install-controls"),
  installLog: document.querySelector("#install-log"),
  logStatus: document.querySelector("#log-status"),
  logWrap: document.querySelector("#log-wrap"),
  primaryAction: document.querySelector("#primary-action"),
  statusDot: document.querySelector("#status-dot"),
  title: document.querySelector("#title"),
  updateAction: document.querySelector("#update-action"),
  updateBanner: document.querySelector("#update-banner"),
  updateDismiss: document.querySelector("#update-dismiss"),
  updateMessage: document.querySelector("#update-message"),
  updateProgress: document.querySelector("#update-progress"),
  updateTitle: document.querySelector("#update-title"),
};

let primaryAction = null;
let updateAction = null;
let discoveryPending = false;
let discoverySignature = null;

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function render({
  activity = null,
  description,
  dot = "working",
  eyebrow = "DESKTOP COMPANION",
  showInstall = false,
  title,
}) {
  elements.eyebrow.textContent = eyebrow;
  elements.title.textContent = title;
  elements.description.textContent = description;
  elements.statusDot.className = `status-dot ${dot}`;
  show(elements.activity, Boolean(activity));
  if (activity) {
    elements.activityLabel.textContent = activity;
  }
  show(elements.installControls, showInstall);
  show(elements.actionControls, false);
}

function renderAction(options, action) {
  render(options);
  primaryAction = action;
  elements.primaryAction.textContent = options.actionLabel;
  show(elements.actionControls, true);
}

function appendLog(line) {
  elements.installLog.textContent += `${line}\n`;
  elements.installLog.scrollTop = elements.installLog.scrollHeight;
}

function renderUpdate({ action = null, actionLabel = "", message, progress = false, title }) {
  elements.updateTitle.textContent = title;
  elements.updateMessage.textContent = message;
  updateAction = action;
  elements.updateAction.textContent = actionLabel;
  show(elements.updateAction, Boolean(action));
  show(elements.updateProgress, progress);
  show(elements.updateBanner, true);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function friendlyError(error) {
  if (typeof error === "string") {
    return error;
  }
  return error?.message || "OpenClaw could not complete the operation.";
}

function gatewayHost(gateway) {
  return (gateway.host || "").trim().replace(/\.$/, "");
}

function canConnectDirect(gateway) {
  return (
    gateway.tls ||
    gateway.directReachable ||
    gatewayHost(gateway).toLowerCase().endsWith(".ts.net")
  );
}

function renderGateways(gateways) {
  elements.gatewayList.replaceChildren();
  elements.discoveryStatus.textContent = gateways.length ? `${gateways.length} FOUND` : "SEARCHING";
  if (!gateways.length) {
    const empty = document.createElement("p");
    empty.className = "discovery-empty";
    empty.textContent = "Looking for nearby OpenClaw gateways…";
    elements.gatewayList.append(empty);
    return;
  }

  for (const gateway of gateways) {
    const button = document.createElement("button");
    button.className = "gateway-card";
    button.type = "button";
    button.disabled = !canConnectDirect(gateway);
    if (button.disabled) {
      button.title = "This gateway does not advertise a direct connection.";
    }

    const copy = document.createElement("span");
    copy.className = "gateway-copy";
    const name = document.createElement("span");
    name.className = "gateway-name";
    name.textContent = gateway.name;
    const endpoint = document.createElement("span");
    endpoint.className = "gateway-endpoint";
    endpoint.textContent = `${gatewayHost(gateway)}:${gateway.port}`;
    copy.append(name, endpoint);

    const badge = document.createElement("span");
    badge.className = `gateway-badge${gateway.tls ? " secure" : ""}`;
    badge.textContent = gateway.tls ? "TLS" : "HTTP";
    button.append(copy, badge);
    button.addEventListener("click", () => {
      button.disabled = true;
      void invoke("connect_discovered_gateway", {
        host: gateway.host,
        port: gateway.port,
        tls: gateway.tls,
      }).catch(() => {
        button.disabled = false;
        elements.discoveryStatus.textContent = "CONNECT FAILED";
      });
    });
    elements.gatewayList.append(button);
  }
}

async function refreshGateways() {
  if (discoveryPending) {
    return;
  }
  discoveryPending = true;
  try {
    const gateways = await invoke("discover_gateways");
    const signature = JSON.stringify(gateways);
    if (signature !== discoverySignature) {
      discoverySignature = signature;
      renderGateways(gateways);
    }
  } catch {
    discoverySignature = null;
    elements.discoveryStatus.textContent = "UNAVAILABLE";
  } finally {
    discoveryPending = false;
  }
}

async function connect() {
  render({
    activity: "Checking local services…",
    description: "Finding your gateway and preparing the Control UI.",
    title: "Connecting to OpenClaw",
  });
  try {
    const snapshot = await invoke("bootstrap");
    if (snapshot.phase === "missingCli") {
      const buildInfo = await invoke("build_info").catch(() => null);
      if (buildInfo?.releaseBuild === false) {
        elements.channel.value = "dev";
        render({
          description:
            "This companion is a development build, so its Gateway install should usually use the matching release channel.",
          eyebrow: "FIRST-RUN SETUP",
          showInstall: true,
          title: "Choose a release channel",
        });
        return;
      }
      render({
        activity: "Starting the bundled installer…",
        description: "OpenClaw is installing its managed CLI and Node runtime.",
        eyebrow: "FIRST-RUN SETUP",
        title: "Preparing OpenClaw",
      });
      await install();
    }
  } catch (error) {
    renderRetry(friendlyError(error));
  }
}

async function install() {
  elements.installButton.disabled = true;
  elements.channel.disabled = true;
  elements.installLog.textContent = "";
  elements.logStatus.textContent = "RUNNING";
  show(elements.logWrap, true);
  render({
    activity: "Installing OpenClaw…",
    description: "A managed CLI and Node runtime are being installed in your home directory.",
    eyebrow: "INSTALLING",
    title: "Preparing your companion",
  });
  try {
    await invoke("install_cli", { channel: elements.channel.value });
    elements.logStatus.textContent = "COMPLETE";
  } catch (error) {
    elements.logStatus.textContent = "FAILED";
    appendLog(friendlyError(error));
    render({
      description:
        "Installation did not finish. Review the final log lines, choose a release channel, then retry.",
      dot: "error",
      eyebrow: "INSTALLATION ISSUE",
      showInstall: true,
      title: "OpenClaw needs attention",
    });
  } finally {
    elements.installButton.disabled = false;
    elements.channel.disabled = false;
  }
}

async function runGatewayAction(action) {
  render({
    activity: `${action === "restart" ? "Restarting" : "Starting"} gateway…`,
    description: "OpenClaw is waiting for the local gateway to become healthy.",
    eyebrow: "GATEWAY",
    title: "One moment",
  });
  try {
    await invoke("gateway_action", { action });
  } catch (error) {
    renderRetry(friendlyError(error));
  }
}

function renderRetry(message) {
  show(elements.logWrap, false);
  renderAction(
    {
      actionLabel: "Try again",
      description: message,
      dot: "error",
      eyebrow: "CONNECTION ISSUE",
      title: "OpenClaw needs attention",
    },
    connect,
  );
}

elements.installButton.addEventListener("click", () => {
  void install();
});
elements.primaryAction.addEventListener("click", () => {
  void primaryAction?.();
});
elements.updateAction.addEventListener("click", () => {
  void updateAction?.();
});
elements.updateDismiss.addEventListener("click", () => {
  show(elements.updateBanner, false);
});

await listen("install-progress", ({ payload }) => appendLog(payload.line));
await listen("updater://not-available", () => {
  renderUpdate({
    message: "No update is available.",
    title: "OpenClaw is up to date",
  });
});
await listen("updater://available", ({ payload }) => {
  elements.updateProgress.removeAttribute("value");
  renderUpdate({
    message: payload.notes || "Downloading in the background…",
    progress: true,
    title: `Update available v${payload.version} — downloading…`,
  });
});
await listen("updater://progress", ({ payload }) => {
  if (payload.total) {
    elements.updateProgress.max = payload.total;
    elements.updateProgress.value = payload.downloaded;
    elements.updateMessage.textContent = `${formatBytes(payload.downloaded)} of ${formatBytes(payload.total)}`;
  } else {
    elements.updateProgress.removeAttribute("value");
    elements.updateMessage.textContent = `${formatBytes(payload.downloaded)} downloaded`;
  }
});
await listen("updater://ready", ({ payload }) => {
  renderUpdate({
    action: () => invoke("relaunch"),
    actionLabel: "Restart to update",
    message: `Version v${payload.version} is installed and ready.`,
    title: "Update ready",
  });
});
await listen("updater://available-manual", ({ payload }) => {
  renderUpdate({
    action: () =>
      invoke("open_release_page").catch((error) => {
        renderUpdate({
          message: friendlyError(error),
          title: "Could not open release page",
        });
      }),
    actionLabel: "Open download page",
    message: payload.notes || "Install the latest system package from the release page.",
    title: `Update available v${payload.version}`,
  });
});
await listen("updater://error", ({ payload }) => {
  renderUpdate({
    message: payload.message,
    title: "Update check failed",
  });
});
void invoke("updater_ready");
void refreshGateways();
window.setInterval(() => void refreshGateways(), 2000);

const mode = new URLSearchParams(window.location.search).get("mode");
if (mode === "reconnecting") {
  render({
    activity: "Retrying every few seconds…",
    description: "The gateway connection dropped. OpenClaw will restore the dashboard automatically.",
    eyebrow: "GATEWAY OFFLINE",
    title: "Reconnecting",
  });
} else if (mode === "stopped") {
  renderAction(
    {
      actionLabel: "Start Gateway",
      description: "The gateway is stopped. The desktop companion will remain available in the tray.",
      dot: "idle",
      eyebrow: "GATEWAY STOPPED",
      title: "OpenClaw is standing by",
    },
    () => runGatewayAction("start"),
  );
} else if (mode === "error") {
  renderRetry("The last gateway action failed. Check the service, then retry.");
} else {
  await connect();
}
