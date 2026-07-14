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
  installButton: document.querySelector("#install-button"),
  installControls: document.querySelector("#install-controls"),
  installLog: document.querySelector("#install-log"),
  logStatus: document.querySelector("#log-status"),
  logWrap: document.querySelector("#log-wrap"),
  primaryAction: document.querySelector("#primary-action"),
  statusDot: document.querySelector("#status-dot"),
  title: document.querySelector("#title"),
};

let primaryAction = null;

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

function friendlyError(error) {
  if (typeof error === "string") {
    return error;
  }
  return error?.message || "OpenClaw could not complete the operation.";
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

await listen("install-progress", ({ payload }) => appendLog(payload.line));

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
