import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createWorkerSshRunner } from "./tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import {
  PWD_COMMAND,
  SSH,
  deferred,
  fakeRunner,
  resolveIdentity,
  startTestTunnel,
  success,
  waitForStarts,
} from "./tunnel.test-support.js";

describe("worker tunnel manager", () => {
  it("cascades only an epoch-matched environment stop into the desktop tunnel owner", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.desktop.acquire({
      environmentId: "worker:desktop-cascade",
      ownerEpoch: 2,
      ssh: SSH,
      desktop: { protocol: "rfb", port: 5900 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await starting;
    const close = vi.fn();
    manager.desktop.attachObserver("worker:desktop-cascade", {
      control: false,
      ownerEpoch: 2,
      close,
    });

    await manager.stop("worker:desktop-cascade", 1);

    expect(fake.starts[0]?.process.stopCount).toBe(0);
    expect(close).not.toHaveBeenCalled();

    await manager.stop("worker:desktop-cascade", 2);

    expect(fake.starts[0]?.process.stopCount).toBe(1);
    expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed");
  });

  it("prepares pinned workspace SSH without starting a persistent tunnel", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const handle = await startTestTunnel(manager, "worker:one", 3);

    expect(manager.status("worker:one")).toBe("connected");
    expect(fake.starts).toHaveLength(0);
    expect(handle.launchTurn).toBeUndefined();
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());

    const workspace = fake.runs.at(-1);
    expect(workspace?.argv).toContain("ClearAllForwardings=yes");
    expect(workspace?.argv).toContain("ControlMaster=no");
    expect(workspace?.argv).toContain("ControlPath=none");
    expect(workspace?.argv).not.toContain("-R");
    expect(workspace?.argv.at(-1)).toContain("pwd");

    await handle.stop();
    expect(manager.status("worker:one")).toBe("stopped");
  });

  it("renews a workspace quiescence lease while reconciliation is still running", async () => {
    const nonce = "a".repeat(32);
    const fake = fakeRunner((argv) => {
      const remoteCommand = argv.at(-1) ?? "";
      if (remoteCommand.includes('process.stdout.write("quiesced "')) {
        return success(`quiesced ${nonce}\n`);
      }
      if (remoteCommand.includes('process.stdout.write("renewed "')) {
        return success(`renewed ${nonce}\n`);
      }
      return undefined;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const handle = await startTestTunnel(manager, "worker:quiescence-renewal", 3);

    vi.useFakeTimers();
    try {
      const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(
        fake.runs.filter((entry) => entry.argv.at(-1)?.includes('process.stdout.write("renewed "')),
      ).toHaveLength(1);
      await quiescence.resume();
    } finally {
      vi.useRealTimers();
      await handle.stop();
    }
  });

  it("passes shared-host isolation to initial and renewal quiescence commands", async () => {
    const nonce = "b".repeat(32);
    const fake = fakeRunner((argv) => {
      const remoteCommand = argv.at(-1) ?? "";
      if (remoteCommand.includes('process.stdout.write("quiesced "')) {
        return success(`quiesced ${nonce}\n`);
      }
      if (remoteCommand.includes('process.stdout.write("renewed "')) {
        return success(`renewed ${nonce}\n`);
      }
      return undefined;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const handle = await startTestTunnel(manager, "worker:shared-quiescence", 3, SSH, true);

    const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
    await quiescence.assertActive();
    const quiescenceCommands = fake.runs.filter((entry) =>
      entry.argv.at(-1)?.includes("workspace quiescence"),
    );
    expect(quiescenceCommands).toHaveLength(2);
    expect(quiescenceCommands.every((entry) => entry.argv.at(-1)?.includes("shared-host"))).toBe(
      true,
    );
    await quiescence.resume();
    await handle.stop();
  });

  it("fences stale owners when a replacement epoch takes ownership", async () => {
    const fake = fakeRunner((argv) =>
      argv.at(-1)?.includes('process.stdout.write("quiesced "')
        ? success(`quiesced ${"c".repeat(32)}\n`)
        : undefined,
    );
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const stale = await startTestTunnel(manager, "worker:epoch", 4);
    const quiescence = await stale.quiesceWorkspace("/home/worker/workspace");

    await expect(startTestTunnel(manager, "worker:epoch", 3)).rejects.toThrow("epoch is stale");

    const replacement = await startTestTunnel(manager, "worker:epoch", 5);
    const priorCommands = fake.runs.length;
    await expect(quiescence.resume()).resolves.toBeUndefined();
    expect(fake.runs).toHaveLength(priorCommands);
    await expect(stale.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow(
      "Worker tunnel owner is no longer connected",
    );
    await expect(replacement.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    expect(replacement.ownerEpoch).toBe(5);
    expect(manager.status("worker:epoch")).toBe("connected");
    await replacement.stop();
  });

  it.each(["stop", "stopAll"] as const)(
    "joins %s while identity preparation drains",
    async (operation) => {
      const identity = deferred<Awaited<ReturnType<typeof resolveIdentity>>>();
      const preparing = deferred<void>();
      const fake = fakeRunner();
      const manager = createWorkerTunnelManager({ runner: fake.runner });
      const starting = manager.start({
        environmentId: "worker:pending",
        ownerEpoch: 1,
        bundleHash: "a".repeat(64),
        ssh: SSH,
        resolveIdentity: async () => {
          preparing.resolve();
          return await identity.promise;
        },
      });
      const rejected = expect(starting).rejects.toThrow(
        "Worker tunnel owner is no longer connected",
      );
      await preparing.promise;
      const stops = [
        operation === "stop" ? manager.stop("worker:pending", 1) : manager.stopAll(),
        manager.stop("worker:pending", 1),
        manager.stopAll(),
      ];
      const settled = vi.fn();
      stops.forEach((stopping) => void stopping.then(settled));
      try {
        await setImmediate();
        expect(manager.status("worker:pending")).toBe("stopped");
        expect(settled).not.toHaveBeenCalled();
      } finally {
        identity.resolve(await resolveIdentity());
        await Promise.all([...stops, rejected]);
      }
    },
  );

  it.each(["stop", "stopAll"] as const)(
    "joins reentrant %s until workspace commands release their SSH files",
    async (operation) => {
      const entered = deferred<void>();
      const command = deferred<ReturnType<typeof success>>();
      let reentered: Promise<void> | undefined;
      let knownHostsPath = "";
      const fake = fakeRunner(async (argv, options) => {
        knownHostsPath = argv
          .find((arg) => arg.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        options.signal!.addEventListener(
          "abort",
          () => {
            reentered =
              operation === "stop" ? manager.stop("worker:command", 1) : manager.stopAll();
          },
          { once: true },
        );
        entered.resolve();
        return await command.promise;
      });
      const manager = createWorkerTunnelManager({ runner: fake.runner });
      const handle = await startTestTunnel(manager, "worker:command", 1);
      const running = handle.runWorkspaceCommand(PWD_COMMAND);
      await entered.promise;
      const stopping = handle.stop();
      const settled = vi.fn();
      void reentered!.then(settled);
      try {
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        await expect(fs.access(knownHostsPath)).resolves.toBeUndefined();
        await expect(handle.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow(
          "no longer connected",
        );
      } finally {
        command.resolve(success());
        await Promise.all([running, stopping, reentered]);
      }
      await expect(fs.access(knownHostsPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { ownerEpoch: 1, stopAgain: false },
    { ownerEpoch: 1, stopAgain: true },
    { ownerEpoch: 2, stopAgain: true },
  ])(
    "waits for SSH cleanup before replacement epoch $ownerEpoch (stop again: $stopAgain)",
    async ({ ownerEpoch, stopAgain }) => {
      const entered = deferred<void>();
      const command = deferred<ReturnType<typeof success>>();
      let knownHostsPath = "";
      const fake = fakeRunner(async (argv) => {
        knownHostsPath = argv
          .find((arg) => arg.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length);
        entered.resolve();
        return await command.promise;
      });
      const manager = createWorkerTunnelManager({ runner: fake.runner });
      const first = await startTestTunnel(manager, "worker:replacement", 1);
      const running = first.runWorkspaceCommand(PWD_COMMAND);
      await entered.promise;
      const stopping = first.stop();
      const nextIdentity = vi.fn(async () => {
        await expect(fs.access(knownHostsPath)).rejects.toMatchObject({ code: "ENOENT" });
        return await resolveIdentity();
      });
      const replacing = manager.start({
        environmentId: "worker:replacement",
        ownerEpoch,
        bundleHash: "a".repeat(64),
        ssh: SSH,
        resolveIdentity: nextIdentity,
      });
      void replacing.catch(() => undefined);
      const retainedStop = stopAgain ? manager.stop("worker:replacement", 1) : undefined;
      const stopped = vi.fn();
      void retainedStop?.then(stopped);
      try {
        await setImmediate();
        expect(stopped).not.toHaveBeenCalled();
        expect(nextIdentity).not.toHaveBeenCalled();
        expect(manager.status("worker:replacement")).toBe(
          ownerEpoch === 1 && stopAgain ? "stopped" : "connecting",
        );
        command.resolve(success());
        await Promise.all([running, stopping, retainedStop]);
        if (ownerEpoch === 1 && stopAgain) {
          await expect(replacing).rejects.toThrow("no longer connected");
          expect(nextIdentity).not.toHaveBeenCalled();
        } else {
          const replacement = await replacing;
          expect(nextIdentity).toHaveBeenCalledOnce();
          await expect(replacement.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
        }
      } finally {
        command.resolve(success());
        await Promise.all([running, stopping, retainedStop, replacing.catch(() => undefined)]);
        await manager.stopAll();
      }
    },
  );

  it("joins a replacement's initialization when prior-owner abort reenters Stop", async () => {
    const entered = deferred<void>();
    const command = deferred<ReturnType<typeof success>>();
    let shutdown: Promise<void> | undefined;
    const settled = vi.fn();
    const fake = fakeRunner(async (_argv, options) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          shutdown = manager.stopAll();
          void shutdown.then(settled);
        },
        { once: true },
      );
      entered.resolve();
      return await command.promise;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const first = await startTestTunnel(manager, "worker:reentrant-replacement", 1);
    const running = first.runWorkspaceCommand(PWD_COMMAND);
    await entered.promise;
    const replacing = startTestTunnel(manager, "worker:reentrant-replacement", 2);
    const rejected = expect(replacing).rejects.toThrow("no longer connected");
    try {
      expect(shutdown).toBeDefined();
      await setImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(manager.status("worker:reentrant-replacement")).toBe("stopped");
    } finally {
      command.resolve(success());
      await Promise.all([running, shutdown, rejected]);
    }
    expect(fake.runs).toHaveLength(1);
  });
});

describe("createWorkerSshRunner diagnostic tails", () => {
  it("keeps SSH tunnel failure stderr on a valid UTF-16 boundary", async () => {
    const retained = "b".repeat(4095);
    const child = createWorkerSshRunner().start(
      [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`a😀${retained}`)})`],
      { timeoutMs: 10_000, baseEnv: process.env },
    );

    await expect(child.ready).rejects.toThrow(`Worker SSH tunnel failed: ${retained}`);
    await child.exited;
  });
});
