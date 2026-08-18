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
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const stale = await startTestTunnel(manager, "worker:epoch", 4);

    await expect(startTestTunnel(manager, "worker:epoch", 3)).rejects.toThrow("epoch is stale");

    const replacement = await startTestTunnel(manager, "worker:epoch", 5);
    await expect(stale.runWorkspaceCommand(PWD_COMMAND)).rejects.toThrow(
      "Worker tunnel owner is no longer connected",
    );
    await expect(replacement.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    expect(replacement.ownerEpoch).toBe(5);
    expect(manager.status("worker:epoch")).toBe("connected");
    await replacement.stop();
  });

  it("fails initialization that loses ownership before identity preparation completes", async () => {
    const identity = deferred<Awaited<ReturnType<typeof resolveIdentity>>>();
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:pending",
      ownerEpoch: 1,
      bundleHash: "a".repeat(64),
      ssh: SSH,
      resolveIdentity: async () => await identity.promise,
    });

    const stopping = manager.stop("worker:pending", 1);
    identity.resolve(await resolveIdentity());

    await stopping;
    await expect(starting).rejects.toThrow("Worker tunnel owner is no longer connected");
    expect(manager.status("worker:pending")).toBe("stopped");
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
