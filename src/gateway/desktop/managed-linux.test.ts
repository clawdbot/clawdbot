import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { createManagedLinuxDesktop } from "./managed-linux.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function exited(stderr = ""): RunExit {
  return {
    reason: "exit",
    exitCode: 1,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr,
    timedOut: false,
    noOutputTimedOut: false,
  };
}

function createFakeSupervisor() {
  const inputs: SpawnInput[] = [];
  const runs: Array<{
    managed: ManagedRun;
    settle: (exit: RunExit) => void;
    settled: boolean;
    scopeKey?: string;
  }> = [];
  const supervisor: ProcessSupervisor = {
    acquireScopeCleanup() {
      throw new Error("Desktop fixture does not own a cleanup scope");
    },
    async spawn(input) {
      inputs.push(input);
      let settle!: (exit: RunExit) => void;
      const wait = new Promise<RunExit>((resolve) => {
        settle = resolve;
      });
      const record = {
        managed: undefined as unknown as ManagedRun,
        settle,
        settled: false,
        scopeKey: input.scopeKey,
      };
      const managed: ManagedRun = {
        activity: {
          get resultSettled() {
            return record.settled;
          },
          lastOutputAtMs: 0,
        },
        runId: `run-${runs.length}`,
        startedAtMs: 0,
        wait: async () => await wait,
        cancel: () => {
          if (!record.settled) {
            record.settled = true;
            record.settle(exited());
          }
        },
      };
      record.managed = managed;
      runs.push(record);
      return managed;
    },
    cancel(runId) {
      runs.find((run) => run.managed.runId === runId)?.managed.cancel();
    },
    cancelScope(scopeKey) {
      for (const run of runs) {
        if (run.scopeKey === scopeKey) {
          run.managed.cancel();
        }
      }
    },
  };
  return {
    inputs,
    runs,
    supervisor,
    exit(index: number, stderr = "") {
      const run = runs[index];
      if (!run || run.settled) {
        throw new Error(`fake run ${index} is unavailable`);
      }
      run.settled = true;
      run.settle(exited(stderr));
    },
  };
}

async function createFixture() {
  const root = tempDirs.make("openclaw-managed-linux-test-");
  const x11SocketDir = path.join(root, "x11");
  await fs.mkdir(x11SocketDir);
  const fake = createFakeSupervisor();
  let now = 0;
  const runPasswordTool = vi.fn(async () => ({
    stdout: Buffer.from("12345678", "hex"),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  }));
  const probeRfb = vi
    .fn()
    .mockResolvedValueOnce({ kind: "unreachable" as const })
    .mockResolvedValue({ kind: "rfb" as const, securityTypes: [2] });
  const desktop = createManagedLinuxDesktop({
    supervisor: fake.supervisor,
    runtime: {
      nowMs: () => now,
      probeRfb,
      readinessPollMs: 1,
      readinessTimeoutMs: 100,
      runPasswordTool,
      sleep: async (ms) => {
        now += ms;
      },
      tempRoot: root,
      tryListenOnPort: async () => 45_999,
      x11SocketDir,
    },
  });
  return { desktop, fake, probeRfb, root, runPasswordTool, x11SocketDir };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("condition did not settle");
}

describe("managed Linux desktop", () => {
  it("starts lazily with the exact TigerVNC recipe and a private ephemeral password", async () => {
    const { desktop, fake, probeRfb, root, runPasswordTool } = await createFixture();
    expect(fake.inputs).toHaveLength(0);

    const acquired = await desktop.acquire();
    expect(acquired).toMatchObject({
      attachment: { kind: "tcp", host: "127.0.0.1", port: 45_999 },
      auth: "vnc-password",
    });
    expect(acquired.vncPassword).toHaveLength(8);
    expect(isSecretValueRegisteredForRedaction(acquired.vncPassword)).toBe(true);
    expect(probeRfb).toHaveBeenCalledTimes(2);
    expect(runPasswordTool).toHaveBeenCalledWith(
      ["tigervncpasswd", "-f"],
      expect.objectContaining({ input: expect.any(Buffer) }),
    );

    const vncInput = fake.inputs[0];
    const sessionInput = fake.inputs[1];
    if (vncInput?.mode !== "child" || sessionInput?.mode !== "child") {
      throw new Error("expected child process inputs");
    }
    const passwordFile = vncInput.argv[vncInput.argv.indexOf("-PasswordFile") + 1];
    if (!passwordFile) {
      throw new Error("expected password file argument");
    }
    expect(vncInput.argv.map((value) => (value === passwordFile ? "<password-file>" : value)))
      .toMatchInlineSnapshot(`
        [
          "Xtigervnc",
          ":99",
          "-geometry",
          "1920x1080",
          "-depth",
          "24",
          "-localhost",
          "yes",
          "-rfbport",
          "45999",
          "-SecurityTypes",
          "VncAuth",
          "-PasswordFile",
          "<password-file>",
          "-AlwaysShared",
          "-AcceptSetDesktopSize",
          "-nolisten",
          "tcp",
          "-ac",
        ]
      `);
    expect(sessionInput.argv).toMatchInlineSnapshot(`
      [
        "startxfce4",
      ]
    `);
    expect(sessionInput.env?.DISPLAY).toBe(":99");
    expect((await fs.stat(passwordFile)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(path.join(path.dirname(passwordFile), "password.txt"))).rejects.toThrow();

    await desktop.stop();
    await expect(fs.stat(path.dirname(passwordFile))).rejects.toThrow();
    expect(desktop.status()).toEqual({ state: "not-started" });
    expect(passwordFile.startsWith(root)).toBe(true);
  });

  it("chooses the first free display from :99 and a fresh password for each session", async () => {
    const { desktop, fake, x11SocketDir } = await createFixture();
    await fs.writeFile(path.join(x11SocketDir, "X99"), "");
    await fs.writeFile(path.join(x11SocketDir, "X100"), "");
    const first = await desktop.acquire();
    expect((fake.inputs[0] as Extract<SpawnInput, { mode: "child" }>).argv[1]).toBe(":101");
    await desktop.stop();
    const second = await desktop.acquire();
    expect(second.vncPassword).not.toBe(first.vncPassword);
    await desktop.stop();
  });

  it.each(["Xtigervnc", "startxfce4", "tigervncpasswd"] as const)(
    "names a missing %s binary and the install command",
    async (missingBinary) => {
      const fixture = await createFixture();
      const supervisor: ProcessSupervisor = {
        ...fixture.fake.supervisor,
        async spawn(input) {
          const binary = input.mode === "child" ? input.argv[0] : undefined;
          if (binary === missingBinary) {
            throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
          }
          return await fixture.fake.supervisor.spawn(input);
        },
      };
      const runPasswordTool =
        missingBinary === "tigervncpasswd"
          ? vi.fn(async () => ({
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("spawn ENOENT"),
              code: null,
              signal: null,
              killed: false,
              termination: "error" as const,
            }))
          : fixture.runPasswordTool;
      const desktop = createManagedLinuxDesktop({
        supervisor,
        runtime: {
          probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
          runPasswordTool,
          tempRoot: fixture.root,
          tryListenOnPort: async () => 45_999,
          x11SocketDir: fixture.x11SocketDir,
        },
      });

      await expect(desktop.acquire()).rejects.toThrow(missingBinary);
      await expect(desktop.acquire()).rejects.toThrow(
        "apt install tigervnc-standalone-server tigervnc-tools xfce4-session",
      );
      await desktop.stop();
    },
  );

  it("restarts the pair three times, then reports the last stderr line as failed", async () => {
    const onFailed = vi.fn();
    const fixture = await createFixture();
    const desktop = createManagedLinuxDesktop({
      supervisor: fixture.fake.supervisor,
      onFailed,
      runtime: {
        probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
        runPasswordTool: fixture.runPasswordTool,
        tempRoot: fixture.root,
        tryListenOnPort: async () => 45_999,
        x11SocketDir: fixture.x11SocketDir,
      },
    });
    await desktop.acquire();
    for (const [crash, inputIndex] of [
      [0, 0],
      [1, 2],
      [2, 4],
    ] as const) {
      fixture.fake.exit(inputIndex, `restart ${crash}\n`);
      await waitFor(() => fixture.fake.inputs.length === inputIndex + 4);
    }
    fixture.fake.exit(6, "detail line\nlast stderr line\n");
    await waitFor(() => desktop.status().state === "failed");
    expect(desktop.status()).toMatchObject({
      state: "failed",
      error: expect.stringContaining("last stderr line"),
      display: 99,
      port: 45_999,
    });
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("3 restarts within 5 minutes"));
    await desktop.stop();
  });

  it("stops and removes its session when the registry linger expires", async () => {
    const { desktop } = await createFixture();
    const registry = createDesktopSessionRegistry({ lingerMs: 1 });
    cleanups.push(async () => registry.stopAll());
    await registry.acquire({
      sourceKey: "host",
      ownerEpoch: 0,
      start: () => desktop.acquire(),
      teardown: () => desktop.stop(),
    });
    const observer = registry.attachObserver("host", {
      control: false,
      ownerEpoch: 0,
      close: vi.fn(),
    });
    expect(observer).toBeDefined();
    observer?.release();
    await vi.waitFor(() => expect(desktop.status()).toEqual({ state: "not-started" }));
  });
});
