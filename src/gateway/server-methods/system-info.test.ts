/** Gateway system.info method tests. */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { validateSystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveAdvertisedLanHost: vi.fn(async () => "192.168.1.20"),
}));

// Keep every real export available: other modules in the import graph may pull
// parse/select helpers from this module, and a partial factory would break them.
vi.mock("../../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHost: mocks.resolveAdvertisedLanHost,
}));

import { systemHandlers } from "./system.js";

describe("system.info", () => {
  it("returns a schema-valid host resource snapshot", async () => {
    const respond = vi.fn();

    const request = {
      params: {},
      respond,
      context: {
        getRuntimeConfig: () => ({ gateway: { port: 18789 } }),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system.info"],
      'systemHandlers["system.info"] test invariant',
    )(request);
    await expectDefined(
      systemHandlers["system.info"],
      'systemHandlers["system.info"] test invariant',
    )(request);

    expect(respond).toHaveBeenCalledTimes(2);
    expect(mocks.resolveAdvertisedLanHost).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    if (!validateSystemInfoResult(payload)) {
      throw new Error("system.info returned an invalid payload");
    }
    expect(payload.cpuCount).toBeGreaterThanOrEqual(1);
    expect(payload.memoryTotalBytes).toBeGreaterThan(0);
    expect(payload.processInstanceId).toBe(getGatewayProcessInstanceId());
    expect(payload.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(payload.defaultAgentUtilityModel).toEqual({ status: "unavailable" });
  });
});
