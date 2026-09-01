import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

let activeHost: ControlUiHost | undefined;
let redact: (text: string) => string = () => "Workboard is not active.";

export function bindWorkboardHost(host: ControlUiHost): () => void {
  activeHost = host;
  redact = host.redact;
  return () => {
    if (activeHost === host) {
      activeHost = undefined;
    }
  };
}

export function workboardRedact(text: string): string {
  // Error completions can arrive during teardown; redaction carries no host authority.
  return redact(text);
}

export function workboardHost(): ControlUiHost {
  if (!activeHost || activeHost.signal.aborted) {
    throw new Error("Workboard is no longer active. Reload the plugin to continue.");
  }
  return activeHost;
}

export function workboardLocale(): string {
  return (
    activeHost?.locale ||
    (typeof document === "undefined" ? "en" : document.documentElement.lang) ||
    "en"
  );
}
