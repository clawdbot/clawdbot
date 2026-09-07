import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as services from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await fs.realpath(dirs.make("native-original-observation-"));
  const pkg = await createPackageSwapFixture(root);
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n");
  const definition = path.join(root, "gateway.service");
  await fs.writeFile(definition, "original service\n");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const command = {
    programArguments: [process.execPath, path.join(pkg.packageRoot, "dist", "index.js"), "gateway"],
    sourcePath: definition,
  };
  const service = createMockGatewayService({
    readCommand: vi.fn(async () => command),
    isLoaded: vi.fn(async () => false),
    isEnabled: vi.fn(async () => false),
    readRuntime: vi.fn(async () => ({
      status: "stopped",
      systemd: { unit: "openclaw-gateway.service", managerUid: 1973 },
    })),
  });
  vi.spyOn(services, "resolveGatewayService").mockReturnValue(service);
  let active = true;
  const params = {
    record: {
      runId: randomUUID(),
      source: { stateDir, configPath, profile: null },
      from: { root: pkg.packageRoot, nodePath: process.execPath, version: "1.0.0", buildId: null },
    },
    env,
    definitionPaths: [definition],
    assertCurrent() {
      if (!active) {
        throw new Error("original inspection owner retired");
      }
    },
  };
  return {
    params,
    service,
    command,
    retire: () => {
      active = false;
    },
  };
}

it.each(["darwin", "linux", "win32"] as const)(
  "keeps enable policy distinct from native load state on %s",
  async (platform) => {
    const f = await fixture();
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    if (platform === "win32") {
      vi.mocked(f.service.isLoaded).mockResolvedValue(true);
    }
    const observed = await readUpdateCommandNativeObservation(f.params);
    expect(observed.facts).toEqual({
      exists: true,
      enabled: false,
      loaded: platform !== "darwin",
      stopped: true,
    });
    if (platform === "linux") {
      expect(observed.identity).toMatchObject({ scope: "user", uid: 1973 });
    }
  },
);

it("does not substitute the updater's UID when native user-manager identity is missing", async () => {
  const f = await fixture();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.mocked(f.service.readRuntime).mockResolvedValue({ status: "stopped" });
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
});

it("does not infer disabled policy when the adapter cannot read it", async () => {
  const f = await fixture();
  f.service.isEnabled = undefined;
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
});

it("rejects changed source selectors before querying enable policy", async () => {
  const f = await fixture();
  vi.mocked(f.service.readCommand).mockResolvedValue({
    ...f.command,
    environment: { OPENCLAW_STATE_DIR: path.join(f.params.env.HOME, "different-state") },
  });
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
  expect(f.service.isEnabled).not.toHaveBeenCalled();
});

it("rechecks the original live owner after the awaited enable-policy probe", async () => {
  const f = await fixture();
  f.service.isEnabled = async () => {
    f.retire();
    return false;
  };
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("owner retired");
});

it("rejects a runtime transition while enable policy is being inspected", async () => {
  const f = await fixture();
  f.service.isEnabled = async () => {
    vi.mocked(f.service.readRuntime).mockResolvedValue({ status: "running", pid: 43210 });
    return false;
  };
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
});

it("rejects enable policy that changes during the final native-state read", async () => {
  const f = await fixture();
  let enabled = false;
  let reads = 0;
  f.service.isEnabled = async () => enabled;
  vi.mocked(f.service.readRuntime).mockImplementation(async () => {
    if (++reads === 2) {
      enabled = true;
    }
    return {
      status: "stopped",
      systemd: { unit: "openclaw-gateway.service", managerUid: 1973 },
    };
  });
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
});

it("rejects final selector drift before a second policy query", async () => {
  const f = await fixture();
  vi.mocked(f.service.readCommand)
    .mockResolvedValueOnce(f.command)
    .mockResolvedValue({
      ...f.command,
      environment: { OPENCLAW_STATE_DIR: path.join(f.params.env.HOME, "different-state") },
    });
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
  expect(f.service.isEnabled).toHaveBeenCalledTimes(1);
});

it("rejects native state changes during the last enable-policy probe", async () => {
  const f = await fixture();
  let probes = 0;
  f.service.isEnabled = async () => {
    if (++probes === 2) {
      vi.mocked(f.service.readRuntime).mockResolvedValue({ status: "running", pid: 54321 });
    }
    return false;
  };
  await expect(readUpdateCommandNativeObservation(f.params)).rejects.toThrow("cannot be verified");
});
