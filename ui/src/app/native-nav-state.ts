export type NativeNavState = {
  collapsed: boolean;
  width: number;
};

type WebKitMessageHandler = {
  postMessage(message: unknown): void;
};

type WebKitBridgeWindow = Window & {
  webkit?: {
    messageHandlers?: {
      openclawNav?: WebKitMessageHandler;
    };
  };
};

export function postNativeNavState(state: NativeNavState): void {
  try {
    (window as WebKitBridgeWindow).webkit?.messageHandlers?.openclawNav?.postMessage({
      type: "nav-state",
      ...state,
    });
  } catch {
    // WebKit may remove a handler while the document is being replaced.
  }
}
