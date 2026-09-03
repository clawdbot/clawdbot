import type { ReactiveControllerHost } from "lit";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { nativeGatewaysCapability } from "./native-gateways.runtime.ts";

export function isNativeLocalGateway(): boolean {
  const snapshot = nativeGatewaysCapability()?.snapshot;
  // SSH tunnels give remote gateways loopback URLs; only the native-declared kind proves locality.
  return snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId)?.kind === "local";
}

type EditorFile = { path: string; root?: string | null };

export function localEditorFilePath(content: EditorFile, execNode?: string | null): string | null {
  if (execNode || !isNativeLocalGateway()) {
    return null;
  }
  if (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(content.path)) {
    return content.path;
  }
  return content.root
    ? `${content.root.replace(/[\\/]+$/, "")}/${content.path.replace(/^[\\/]+/, "")}`
    : null;
}

export function observeNativeGateway(host: ReactiveControllerHost, onChange?: () => void): void {
  void new SubscriptionsController(host).watch(
    nativeGatewaysCapability,
    (gateways, notify) => gateways.subscribe(notify),
    onChange,
  );
}
