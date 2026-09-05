/** Gateway system.info method tests. */

import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import * as diskSpace from "../../infra/disk-space.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveAdvertisedLanHostCore: vi.fn(async () => "192.168.1.20"),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

const mountedVolumeOutput = (argv: string[]) => ({
  code: 0,
  stdout:
    argv[0] === "mount"
      ? "/dev/root on / (apfs, local)\n/dev/data on /Volumes/Data (apfs, local)\n"
      : "/dev/root 1000 600 400 60% /\n/dev/data 2000 500 1500 25% /Volumes/Data\n",
  stderr: "",
});

// Keep every real export available: other modules in the import graph may pull
// parse/select helpers from this module, and a partial factory would break them.
vi.mock("../../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHostCore: mocks.resolveAdvertisedLanHostCore,
}));

import { systemHandlers } from "./system.js";

describe("system.info", () => {
  let sampleTime = Date.now();
  beforeEach(() => {
    sampleTime += 10_001;
    vi.spyOn(Date, "now").mockReturnValue(sampleTime);
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    mocks.runCommandWithTimeout.mockReset().mockImplementation(mountedVolumeOutput);
  });
  afterEach(() => vi.restoreAllMocks());

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
    expect(mocks.resolveAdvertisedLanHostCore).toHaveBeenCalledTimes(1);
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
    expect(payload).toHaveProperty("disks", [
      { path: "/", totalBytes: 1_024_000, availableBytes: 409_600 },
      { path: "/Volumes/Data", totalBytes: 2_048_000, availableBytes: 1_536_000 },
    ]);
  });

  it.each(["throw", "mount-exit", "df-exit", "empty"])(
    "preserves the state-directory snapshot only when discovery is unavailable (%s)",
    async (failure) => {
      vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        totalBytes: 2048,
        availableBytes: 1024,
      }));
      if (failure === "throw") {
        mocks.runCommandWithTimeout.mockRejectedValueOnce(new Error("unavailable"));
      } else {
        if (failure === "df-exit") {
          mocks.runCommandWithTimeout.mockImplementationOnce(mountedVolumeOutput);
        }
        mocks.runCommandWithTimeout.mockResolvedValueOnce({
          code: failure === "empty" ? 0 : 1,
          stdout: "",
          stderr: "",
        });
      }
      const respond = vi.fn();
      await expectDefined(
        systemHandlers["system.info"],
        "system.info handler",
      )({
        params: {},
        respond,
        context: { getRuntimeConfig: () => ({}) },
      } as unknown as GatewayRequestHandlerOptions);
      const [ok, payload] = respond.mock.calls[0] ?? [];
      expect(ok).toBe(true);
      if (!validateSystemInfoResult(payload)) {
        throw new Error("system.info returned an invalid payload");
      }
      expect(payload.disks).toEqual(
        failure === "empty"
          ? []
          : [{ path: payload.diskPath, totalBytes: 2048, availableBytes: 1024 }],
      );
    },
  );
});
