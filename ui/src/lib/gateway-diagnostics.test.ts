import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { loadGatewayDiagnostics } from "./gateway-diagnostics.ts";

describe("loadGatewayDiagnostics", () => {
  it("reads only the prepared model catalog during automatic diagnostics", async () => {
    const request = vi.fn(async (method: string) =>
      method === "models.list" ? { models: [] } : {},
    );

    await loadGatewayDiagnostics({ request } as unknown as GatewayBrowserClient);

    expect(request).toHaveBeenCalledWith(
      "models.list",
      { preparedOnly: true },
      { signal: undefined },
    );
  });
});
