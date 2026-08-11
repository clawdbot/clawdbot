const connectionStatus = document.getElementById("connectionStatus");
const bootstrapStatus = document.getElementById("bootstrapStatus");
const automaticSetup = document.getElementById("automaticSetup");
const accessMode = document.getElementById("accessMode");
const pairingString = document.getElementById("pairingString");
const pair = document.getElementById("pair");
const useLocal = document.getElementById("useLocal");
const disconnect = document.getElementById("disconnect");
const message = document.getElementById("message");
const retiredCustody = document.getElementById("retiredCustody");

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  const custodyBlocked = status.retiredCopilotCustodyBlocked === true;
  retiredCustody.classList.toggle("hidden", !custodyBlocked);
  connectionStatus.textContent = status.paired
    ? custodyBlocked
      ? "Paired; automation paused"
      : status.state === "on"
        ? "Connected"
        : "Paired; relay unavailable"
    : "Not paired";
  automaticSetup.checked = !status.nativeBootstrap?.disabled && !custodyBlocked;
  bootstrapStatus.textContent = custodyBlocked
    ? "Retired recovery state requires confirmation"
    : status.nativeBootstrap?.disabled
      ? "Automatic setup disabled"
      : status.nativeBootstrap?.state === "manual_required"
        ? `Manual setup required (${status.nativeBootstrap.failureCode ?? "unsupported topology"})`
        : status.nativeBootstrap?.state === "retrying"
          ? "Waiting for the local native host"
          : "Automatic bootstrap ready";
  accessMode.value = status.accessMode === "selected" ? "selected" : "all";
  automaticSetup.disabled = custodyBlocked;
  useLocal.disabled = custodyBlocked;
  accessMode.disabled = !status.paired || custodyBlocked;
  pairingString.disabled = custodyBlocked;
  pair.disabled = custodyBlocked;
  disconnect.disabled = !status.paired && !custodyBlocked;
}

async function showResult(task, success) {
  try {
    const result = await task();
    if (result?.ok === false) {
      throw new Error(result.error ?? "Operation failed.");
    }
    message.textContent = success;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  }
  await refresh();
}

automaticSetup.addEventListener("change", () => {
  void showResult(
    () =>
      chrome.runtime.sendMessage({
        type: "setNativeBootstrapEnabled",
        enabled: automaticSetup.checked,
      }),
    automaticSetup.checked ? "Automatic setup enabled." : "Automatic setup disabled.",
  );
});
useLocal.addEventListener("click", () => {
  void showResult(
    () => chrome.runtime.sendMessage({ type: "setNativeBootstrapEnabled", enabled: true }),
    "Looking for local OpenClaw…",
  );
});
accessMode.addEventListener("change", () => {
  void showResult(
    () => chrome.runtime.sendMessage({ type: "setAccessMode", accessMode: accessMode.value }),
    "Access mode updated.",
  );
});
pair.addEventListener("click", () => {
  void showResult(
    () =>
      chrome.runtime.sendMessage({
        type: "pair",
        pairingString: pairingString.value,
        accessMode: accessMode.value,
      }),
    "Manual pairing saved.",
  );
});
disconnect.addEventListener("click", () => {
  void showResult(
    () => chrome.runtime.sendMessage({ type: "unpair" }),
    "Disconnected. Automatic setup is disabled.",
  );
});

void refresh();
