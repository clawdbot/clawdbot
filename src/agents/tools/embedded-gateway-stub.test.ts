import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedCallGateway } from "./embedded-gateway-stub.js";

const runtime = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ agents: { list: [{ id: "main", default: true }] } })),
  resolveSessionKeyFromResolveParams: vi.fn(),
}));

vi.mock("./embedded-gateway-stub.runtime.js", () => runtime);

describe("embedded gateway stub", () => {
  beforeEach(() => {
    runtime.loadConfig.mockClear();
    runtime.resolveSessionKeyFromResolveParams.mockReset();
  });

  it("resolves sessions through the gateway session resolver", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
    });

    const callGateway = createEmbeddedCallGateway();
    const result = await callGateway<{ ok: true; key: string }>({
      method: "sessions.resolve",
      params: { sessionId: "sess-main", includeGlobal: true },
    });

    expect(result).toEqual({ ok: true, key: "agent:main:main" });
    expect(runtime.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
      p: { sessionId: "sess-main", includeGlobal: true },
    });
  });

  it("throws resolver errors for unresolved sessions", async () => {
    runtime.resolveSessionKeyFromResolveParams.mockResolvedValueOnce({
      ok: false,
      error: { message: "No session found: missing" },
    });

    const callGateway = createEmbeddedCallGateway();

    await expect(
      callGateway({
        method: "sessions.resolve",
        params: { key: "missing" },
      }),
    ).rejects.toThrow("No session found: missing");
  });
});
