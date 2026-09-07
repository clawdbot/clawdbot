import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { client, createGatewayHarness, type RequestFn } from "./overlays-access.test-support.ts";

export function updateRunHarness(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      server: { version: "1.0.0" },
      snapshot: {
        updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
      },
    } as ApplicationGatewaySnapshot["hello"],
  });
  return harness;
}
