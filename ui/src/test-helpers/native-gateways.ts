import { vi } from "vitest";
import * as nativeGateways from "../app/native-gateways.runtime.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";

export function setNativeGatewayTestState(kind: NativeGateway["kind"] | null): void {
  if (!kind) {
    Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
    Reflect.deleteProperty(window, "webkit");
    vi.spyOn(nativeGateways, "nativeGatewaysCapability").mockReturnValue(null);
    return;
  }
  const snapshot: NativeGatewaysSnapshot = {
    gateways: [
      {
        id: "local",
        name: "Local Gateway",
        kind: "local",
        isPrimary: true,
        canPromote: false,
        health: "ok",
      },
      {
        id: "remote",
        name: "Remote Gateway",
        kind: "remote",
        isPrimary: false,
        canPromote: true,
        health: "ok",
      },
    ],
    currentId: kind,
  };
  Object.assign(window, {
    __OPENCLAW_NATIVE_GATEWAYS__: snapshot,
    webkit: { messageHandlers: { openclawGateways: { postMessage: vi.fn() } } },
  });
  window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }));
}

export function clearNativeGatewayTestState(): void {
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
  Reflect.deleteProperty(window, "webkit");
}
