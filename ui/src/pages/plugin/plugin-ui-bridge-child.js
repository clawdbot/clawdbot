// This script must execute before plugin-owned code in the parent-fetched
// srcdoc. It keeps the authority-bearing endpoint private to that document.
(() => {
  const script = document.currentScript;
  const nonce = script?.getAttribute("data-openclaw-plugin-ui-nonce");
  script?.removeAttribute("data-openclaw-plugin-ui-nonce");
  if (!nonce || window.parent === window || Object.hasOwn(window, "openclawPluginUiBridge")) {
    return;
  }

  const parent = window.parent;
  const postToParent = parent.postMessage.bind(parent);
  const channel = new MessageChannel();
  let resolveConnection;
  const connected = new Promise((resolve) => {
    resolveConnection = resolve;
  });
  Object.defineProperty(window, "openclawPluginUiBridge", {
    value: Object.freeze({ connected }),
    writable: false,
    configurable: false,
  });
  channel.port1.addEventListener("message", (event) => {
    if (event.data?.v === 1 && event.data.type === "openclaw.pluginUi.connect") {
      resolveConnection?.({ port: channel.port1, connection: event.data });
      resolveConnection = undefined;
    }
  });
  channel.port1.start();
  postToParent({ v: 1, type: "openclaw.pluginUi.ready", nonce }, "*", [channel.port2]);
})();
