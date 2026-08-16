export type NativeNotificationsPermission = "granted" | "denied" | "notDetermined";

type NativeNotificationsSnapshot = {
  permission: NativeNotificationsPermission | "unknown";
};

type NativeNotificationsMessage =
  | { type: "status" }
  | { type: "request-permission" }
  | { type: "send-test" };

type WebKitNotificationsMessageHandler = {
  postMessage(message: NativeNotificationsMessage): void;
};

type NativeNotificationsWindow = Window & {
  __OPENCLAW_NATIVE_NOTIFICATIONS__?: unknown;
  webkit?: {
    messageHandlers?: {
      openclawNotifications?: WebKitNotificationsMessageHandler;
    };
  };
};

// Wire contract with the Mac app's dashboard bridge (DashboardWindowController+Notifications.swift).
const NATIVE_NOTIFICATIONS_STATUS_EVENT = "openclaw:native-notifications-status";

export type NativeNotificationsCapability = {
  readonly snapshot: NativeNotificationsSnapshot;
  subscribe(listener: (snapshot: NativeNotificationsSnapshot) => void): () => void;
  requestPermission(): void;
  sendTest(): void;
  dispose(): void;
};

function isNativeNotificationsPermission(value: unknown): value is NativeNotificationsPermission {
  return value === "granted" || value === "denied" || value === "notDetermined";
}

function snapshotFrom(value: unknown): NativeNotificationsSnapshot | null {
  if (typeof value !== "object" || value === null || !("permission" in value)) {
    return null;
  }
  return isNativeNotificationsPermission(value.permission)
    ? { permission: value.permission }
    : null;
}

function getNativeNotificationsPoster():
  | WebKitNotificationsMessageHandler["postMessage"]
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const handler = (window as NativeNotificationsWindow).webkit?.messageHandlers
    ?.openclawNotifications;
  return handler?.postMessage.bind(handler);
}

export function createNativeNotificationsCapability(): NativeNotificationsCapability | null {
  const postMessage = getNativeNotificationsPoster();
  if (!postMessage) {
    return null;
  }

  const nativeWindow = window as NativeNotificationsWindow;
  let snapshot = snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_NOTIFICATIONS__"]) ?? {
    permission: "unknown" as const,
  };
  const listeners = new Set<(snapshot: NativeNotificationsSnapshot) => void>();

  const publish = (next: NativeNotificationsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const handleStatus = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (next) {
      publish(next);
    }
  };
  // Permission may change in System Settings while the app is backgrounded.
  const refreshStatus = () => postMessage({ type: "status" });

  window.addEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
  window.addEventListener("focus", refreshStatus);
  refreshStatus();

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestPermission() {
      postMessage({ type: "request-permission" });
    },
    sendTest() {
      postMessage({ type: "send-test" });
    },
    dispose() {
      window.removeEventListener(NATIVE_NOTIFICATIONS_STATUS_EVENT, handleStatus);
      window.removeEventListener("focus", refreshStatus);
      listeners.clear();
    },
  };
}
