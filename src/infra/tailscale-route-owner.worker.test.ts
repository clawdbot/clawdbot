import { fork } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  TAILSCALE_ROUTE_OWNER_ARG,
  type TailscaleRouteOwnerMessage,
} from "./tailscale-route-owner-protocol.js";
import { runTailscaleRouteOwner } from "./tailscale-route-owner.worker.js";

function spawnRouteOwnerFixture() {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.tailscaleRouteOwner);
  const workerPath = fileURLToPath(workerUrl);
  const fixturePath = fileURLToPath(
    new URL("../../test/fixtures/tailscale-foreground-fixture.mjs", import.meta.url),
  );
  const worker = fork(
    workerPath,
    [
      TAILSCALE_ROUTE_OWNER_ARG,
      JSON.stringify({ argv: [fixturePath, "serve", "--yes", "--bg=false", "18789"] }),
    ],
    {
      execArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const messages: TailscaleRouteOwnerMessage[] = [];
  worker.on("message", (message: TailscaleRouteOwnerMessage) => messages.push(message));
  return { messages, worker };
}

describe("Tailscale route owner", () => {
  it("reports readiness and terminates the foreground claim when its owner stops", async () => {
    const messages: TailscaleRouteOwnerMessage[] = [];
    const owner = runTailscaleRouteOwner(
      {
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("Press Ctrl+C to exit.\\n"); setInterval(() => {}, 1000)',
        ],
      },
      (message) => messages.push(message),
    );

    await vi.waitFor(() => {
      expect(messages).toContainEqual({ type: "ready" });
    });
    owner.stop();

    await expect(owner.exited).resolves.toMatchObject({ stopping: true });
    expect(messages.some((message) => message.type === "failed")).toBe(false);
  });

  it("reports command output when the claim exits before readiness", async () => {
    const messages: TailscaleRouteOwnerMessage[] = [];
    const owner = runTailscaleRouteOwner(
      {
        argv: [process.execPath, "-e", 'process.stderr.write("route denied\\n"); process.exit(7)'],
      },
      (message) => messages.push(message),
    );

    await expect(owner.exited).resolves.toMatchObject({ code: 7, stopping: false });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "failed", code: 7, stderr: "route denied\n" }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "terminates the claim when the Gateway IPC owner disappears",
    async () => {
      const { messages, worker } = spawnRouteOwnerFixture();
      try {
        await vi.waitFor(() => {
          expect(messages).toContainEqual({ type: "ready" });
        });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.disconnect();

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates the claim before exiting on an interactive interrupt",
    async () => {
      const { messages, worker } = spawnRouteOwnerFixture();
      let routePid: number | undefined;
      try {
        await vi.waitFor(() => {
          expect(messages).toContainEqual({ type: "ready" });
        });
        const spawned = messages.find((message) => message.type === "spawned");
        if (!spawned) {
          throw new Error("route owner did not report its claim process");
        }
        routePid = spawned.pid;
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.kill("SIGINT");

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
        await vi.waitFor(() => {
          expect(() => process.kill(spawned.pid, 0)).toThrow();
        });
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
        }
        if (routePid) {
          try {
            process.kill(routePid, "SIGKILL");
          } catch {
            // Already released by the worker.
          }
        }
      }
    },
  );
});
