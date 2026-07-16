import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reconcileNodePairingOnConnect } from "../gateway/node-connect-reconcile.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { testing as runtimeRegistryLoaderTesting } from "../plugins/runtime/runtime-registry-loader.js";
import { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const LINUX_NODE_COMMANDS = [
  "camera.clip",
  "camera.list",
  "camera.snap",
  "location.get",
  "system.notify",
] as const;

function resetPluginState(): void {
  resetPluginLoaderTestStateForTest();
  runtimeRegistryLoaderTesting.resetPluginRegistryLoadedForTests();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginState();
});

describe("linux-node node-host integration", () => {
  it("loads and advertises enabled commands through the node-host runtime", async () => {
    resetPluginState();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) {
      throw new Error("process.platform descriptor unavailable");
    }
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });

    const fakeBinDir = path.resolve(".artifacts", "linux-node-test-bin");
    const originalAccessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((candidate, mode) => {
      if (path.dirname(path.resolve(String(candidate))) === fakeBinDir) {
        return;
      }
      return originalAccessSync(candidate, mode);
    });
    vi.stubEnv("PATH", `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);

    const config: OpenClawConfig = {
      gateway: {
        nodes: {
          allowCommands: ["camera.snap", "camera.clip"],
        },
      },
      nodeHost: { skills: { enabled: false } },
      plugins: {
        allow: ["linux-node"],
        entries: {
          "linux-node": {
            enabled: true,
            config: {
              notify: { enabled: true },
              camera: { enabled: true },
              location: { enabled: true },
            },
          },
        },
      },
    };

    try {
      const prepared = await prepareNodeHostRuntime({ config, env: process.env });
      const registered = listRegisteredNodeHostCapsAndCommands({ config, env: process.env });

      expect(registered.commands).toEqual(LINUX_NODE_COMMANDS);
      expect(registered.caps).toEqual(["camera", "location"]);
      expect(prepared.manifest.commands).toEqual(expect.arrayContaining([...LINUX_NODE_COMMANDS]));

      const requestPairing = vi.fn();
      const reconciliation = await reconcileNodePairingOnConnect({
        cfg: config,
        connectParams: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "node-host",
            version: "test",
            platform: "linux",
            deviceFamily: "Linux",
            mode: "node",
          },
          caps: registered.caps,
          commands: registered.commands,
        },
        pairedNode: {
          nodeId: "node-host",
          createdAtMs: 1,
          approvedAtMs: 1,
          caps: registered.caps,
          commands: registered.commands,
        },
        requestPairing,
      });

      expect(reconciliation.declaredCommands).toEqual(LINUX_NODE_COMMANDS);
      expect(reconciliation.effectiveCommands).toEqual(LINUX_NODE_COMMANDS);
      expect(requestPairing).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});
