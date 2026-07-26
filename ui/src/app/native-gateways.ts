export type NativeGateway = {
  id: string;
  name: string;
  kind: "local" | "remote";
  isPrimary: boolean;
  canPromote: boolean;
  health: "ok" | "error" | "unknown";
};

export type NativeGatewaysSnapshot = { gateways: NativeGateway[]; currentId: string };
type NativeGatewaysMessage =
  | { type: "select" | "open-window" | "set-primary"; id: string }
  | { type: "open-settings" };
type NativeGatewaysWindow = Window & {
  __OPENCLAW_NATIVE_GATEWAYS__?: unknown;
  webkit?: {
    messageHandlers?: { openclawGateways?: { postMessage(message: NativeGatewaysMessage): void } };
  };
};

const NATIVE_GATEWAYS_CHANGED_EVENT = "openclaw:native-gateways-changed";

export type NativeGatewaysCapability = {
  readonly snapshot: NativeGatewaysSnapshot | null;
  subscribe(listener: (snapshot: NativeGatewaysSnapshot) => void): () => void;
  select(id: string): void;
  openWindow(id: string): void;
  setPrimary(id: string): void;
  openSettings(): void;
  dispose(): void;
};

function snapshotFrom(value: unknown): NativeGatewaysSnapshot | null {
  if (!value || typeof value !== "object" || !("gateways" in value) || !("currentId" in value)) {
    return null;
  }
  const { gateways, currentId } = value as { gateways: unknown; currentId: unknown };
  if (!Array.isArray(gateways) || typeof currentId !== "string") {
    return null;
  }
  const valid = gateways.every(
    (gateway) =>
      gateway &&
      typeof gateway === "object" &&
      typeof gateway.id === "string" &&
      typeof gateway.name === "string" &&
      (gateway.kind === "local" || gateway.kind === "remote") &&
      typeof gateway.isPrimary === "boolean" &&
      typeof gateway.canPromote === "boolean" &&
      (gateway.health === "ok" || gateway.health === "error" || gateway.health === "unknown"),
  );
  return valid ? { gateways: gateways as NativeGateway[], currentId } : null;
}

export function createNativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeGatewaysWindow;
  const handler = nativeWindow.webkit?.messageHandlers?.openclawGateways;
  if (!handler?.postMessage) {
    return null;
  }
  const post = handler.postMessage.bind(handler);
  let snapshot = snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"]);
  const listeners = new Set<(snapshot: NativeGatewaysSnapshot) => void>();
  const onChange = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (!next) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };
  window.addEventListener(NATIVE_GATEWAYS_CHANGED_EVENT, onChange);
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (id) => post({ type: "select", id }),
    openWindow: (id) => post({ type: "open-window", id }),
    setPrimary: (id) => post({ type: "set-primary", id }),
    openSettings: () => post({ type: "open-settings" }),
    dispose() {
      window.removeEventListener(NATIVE_GATEWAYS_CHANGED_EVENT, onChange);
      listeners.clear();
    },
  };
}
