import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { loadGatewayDiagnostics } from "./gateway-diagnostics.ts";

describe("loadGatewayDiagnostics", () => {
  it("reads only the prepared model catalog during automatic diagnostics", async () => {
    const request = vi.fn(async (method: string) =>
      method === "models.list" ? { models: [] } : {},
    );

    await loadGatewayDiagnostics({ request } as unknown as GatewayBrowserClient, "writer");

    expect(request).toHaveBeenCalledWith(
      "models.list",
      { agentId: "writer", preparedOnly: true },
      { signal: undefined },
    );
  });

  it("keeps diagnostics available without requesting models before agent selection", async () => {
    const request = vi.fn(async (_method: string) => ({}));

    const result = await loadGatewayDiagnostics(
      { request } as unknown as GatewayBrowserClient,
      null,
    );

    expect(result.models).toEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "diagnostics.lanes",
      "status",
      "health",
      "last-heartbeat",
    ]);
  });
});
