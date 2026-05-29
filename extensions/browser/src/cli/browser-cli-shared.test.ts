import { beforeEach, describe, expect, it, vi } from "vitest";
import type { callGatewayFromCli } from "./core-api.js";

type CallGatewayFromCliArgs = Parameters<typeof callGatewayFromCli>;

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./core-api.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const { callBrowserRequest } = await import("./browser-cli-shared.js");

describe("callBrowserRequest", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayFromCli.mockClear();
  });

  it("requests the browser.request admin scope explicitly", async () => {
    await callBrowserRequest(
      { json: true },
      { method: "GET", path: "/status", query: { profile: "openclaw" } },
      { progress: true },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0] as unknown as
      | CallGatewayFromCliArgs
      | undefined;
    const extra = call?.[3];
    expect(extra).toEqual({ progress: true, scopes: ["operator.admin"] });
  });

  it("rejects partial parent timeout values before gateway dispatch", async () => {
    await expect(
      callBrowserRequest({ json: true, timeout: "60000ms" }, { method: "GET", path: "/status" }),
    ).rejects.toThrow("--timeout must be a positive integer.");
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("caps explicit request timeouts to Node's safe timer range", async () => {
    await callBrowserRequest(
      { json: true },
      { method: "GET", path: "/status" },
      { timeoutMs: 3_000_000_000 },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0] as unknown as
      | CallGatewayFromCliArgs
      | undefined;
    expect(call?.[1]).toMatchObject({ timeout: "2147483647" });
    expect(call?.[2]).toMatchObject({ timeoutMs: 2_147_483_647 });
  });

  it("caps parent timeout values to Node's safe timer range", async () => {
    await callBrowserRequest(
      { json: true, timeout: "3000000000" },
      { method: "GET", path: "/status" },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0] as unknown as
      | CallGatewayFromCliArgs
      | undefined;
    expect(call?.[1]).toMatchObject({ timeout: "2147483647" });
    expect(call?.[2]).toMatchObject({ timeoutMs: 2_147_483_647 });
  });
});
