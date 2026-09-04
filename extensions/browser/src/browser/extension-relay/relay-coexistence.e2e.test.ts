import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it } from "vitest";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import {
  externalRelayClient,
  externalVersion,
  withConnectedDaemon,
} from "./relay-coexistence.test-support.js";

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
});

it("borrows the compiled daemon in another process and leaves it serving an external v2 client", async () => {
  let child: ChildProcess | undefined;
  await withConnectedDaemon(
    async ({ port, token }) => {
      const pid = child?.pid;
      expect(pid).toBeTypeOf("number");
      const external = await externalRelayClient(port, token);
      try {
        await startBrowserControlServiceFromConfig();
        const profile = createBrowserControlContext().forProfile("chrome");
        await profile.ensureBrowserAvailable();
        await expect(profile.listTabs()).resolves.toEqual([
          expect.objectContaining({
            targetId: "fixture-target",
            url: "https://example.com/fixture",
          }),
        ]);
        await stopBrowserControlService();
        expect(child?.pid).toBe(pid);
        expect(child?.exitCode).toBeNull();
        await expect(externalVersion(external)).resolves.toMatchObject({
          result: { product: "Chrome/test" },
        });
      } finally {
        external.terminate();
      }
    },
    async (port, stateDir, config) => {
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify(config));
      child = spawn(
        process.execPath,
        [path.resolve("dist/extensions/browser/relay-daemon-entry.js"), "--port", String(port)],
        {
          env: {
            HOME: stateDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const owned = child;
      const done = new Promise<void>((resolve) => {
        owned.once("exit", () => resolve());
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Compiled relay did not become ready")),
            10_000,
          );
          let output = "";
          const onData = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4_096);
            if (output.includes("standalone extension relay listening")) {
              clearTimeout(timer);
              resolve();
            }
          };
          owned.stdout?.on("data", onData);
          owned.stderr?.on("data", onData);
          owned.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          owned.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Compiled relay exited before readiness"));
          });
        });
      } catch (error) {
        owned.kill("SIGTERM");
        await done;
        throw error;
      }
      return {
        stop: () => {
          owned.kill("SIGTERM");
        },
        done,
      };
    },
  );
});
