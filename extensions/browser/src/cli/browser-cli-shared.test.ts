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
});
