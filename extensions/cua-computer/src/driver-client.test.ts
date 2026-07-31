import type { ChildProcess } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import { CuaDriverClient } from "./driver-client.js";

function fakeTransport(): Transport {
  return {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function fakeClient(options: {
  name?: string;
  version?: string;
  capabilityVersion?: string;
  schemaVersion?: string;
  connect?: () => Promise<void>;
  result?: unknown;
  callToolThrows?: boolean;
}) {
  return {
    connect: vi.fn(options.connect ?? (async () => {})),
    getServerVersion: () => ({
      name: options.name ?? "cua-driver",
      version: options.version ?? "0.10.4",
    }),
    listTools: vi.fn(async () => ({
      tools: [],
      capability_version: options.capabilityVersion ?? "1",
      schema_version: options.schemaVersion ?? "1",
    })),
    callTool: vi.fn(async () => {
      if (options.callToolThrows) {
        throw new Error("transport closed");
      }
      return options.result ?? { content: [{ type: "text", text: "ok" }] };
    }),
    close: vi.fn(async () => {}),
  };
}

function createClient(client: ReturnType<typeof fakeClient>) {
  return new CuaDriverClient({
    driverPath: "/opt/bin/cua-driver",
    access: () => {},
    clientFactory: () => client,
    transportFactory: fakeTransport,
  });
}

describe("CuaDriverClient version gate", () => {
  it("accepts cua-driver 0.10.x with capability and schema version 1", async () => {
    const driver = createClient(fakeClient({ version: "0.10.4" }));
    await expect(driver.callTool("get_screen_size", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(driver.generation).toBe(1);
  });

  it.each([
    [{ version: "0.11.0" }, "cua-driver@0.11.0"],
    [{ name: "other-driver" }, "other-driver@0.10.4"],
    [{ capabilityVersion: "2" }, "capability_version=2"],
    [{ schemaVersion: "2" }, "schema_version=2"],
  ])("rejects unsupported initialize/list result %#", async (options, found) => {
    const driver = createClient(fakeClient(options));
    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow(found);
    expect(driver.isAvailable()).toBe(false);
  });

  it("re-probes and recovers after a corrected driver replaces an unsupported one", async () => {
    const clients = [fakeClient({ version: "0.11.0" }), fakeClient({ version: "0.10.4" })];
    let clock = 1_000;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      access: () => {},
      clientFactory: () => clients.shift() ?? fakeClient({ version: "0.10.4" }),
      transportFactory: fakeTransport,
      now: () => clock,
    });

    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow("cua-driver@0.11.0");
    // Within the re-probe window the verdict is cached: unavailable, no reconnect.
    clock += 10_000;
    expect(driver.isAvailable()).toBe(false);
    // After the window, the corrected driver is re-probed and accepted.
    clock += 25_000;
    expect(driver.isAvailable()).toBe(true);
    await expect(driver.callTool("get_screen_size", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
  });
});

describe("CuaDriverClient process contract", () => {
  it("forwards only allowlisted env, opt-outs, and the Wayland setting, dropping secrets", async () => {
    let transportParams: { env?: Record<string, string>; stderr?: unknown } | undefined;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: {
        PATH: "/opt/bin",
        DISPLAY: ":0",
        XDG_RUNTIME_DIR: "/run/user/1000",
        LC_ALL: "en_US.UTF-8",
        CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
        OPENAI_API_KEY: "sk-should-not-leak",
        ANTHROPIC_API_KEY: "should-not-leak",
        SLACK_BOT_TOKEN: "xoxb-should-not-leak",
        CUA_API_KEY: "cua-cloud-should-not-leak",
      },
      access: () => {},
      clientFactory: () => fakeClient({}),
      transportFactory: (params) => {
        transportParams = params;
        return fakeTransport();
      },
    });

    await driver.callTool("get_screen_size", {});

    expect(transportParams?.env).toMatchObject({
      PATH: "/opt/bin",
      DISPLAY: ":0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      LC_ALL: "en_US.UTF-8",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
    });
    expect(transportParams?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(transportParams?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(transportParams?.env).not.toHaveProperty("SLACK_BOT_TOKEN");
    // The CUA_ namespace holds cloud credentials, so it is not prefix-allowed.
    expect(transportParams?.env).not.toHaveProperty("CUA_API_KEY");
    expect(transportParams?.stderr).toBe("ignore");
  });

  it("starts serve and connects on the first readiness poll", async () => {
    const first = fakeClient({
      connect: async () => {
        throw new Error("daemon absent");
      },
    });
    const second = fakeClient({});
    const clients = [first, second];
    const kill = vi.fn();
    const child = {
      exitCode: null,
      once: vi.fn(),
      unref: vi.fn(),
      kill,
    } as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => child);
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () => clients.shift() ?? second,
      transportFactory: fakeTransport,
      spawn: spawnProcess as unknown as typeof import("node:child_process").spawn,
      sleep: async () => {},
    });

    await driver.callTool("get_screen_size", {});
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/bin/cua-driver",
      ["serve"],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
        }),
      }),
    );
    await driver.dispose();
    // The shared machine daemon must outlive our client; dispose closes the mcp
    // session but never kills serve, so other cua-driver clients stay connected.
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps polling through a slow daemon start and records the backoff delays", async () => {
    const failing = () =>
      fakeClient({
        connect: async () => {
          throw new Error("daemon still starting");
        },
      });
    const clients = [failing(), failing(), failing(), fakeClient({})];
    const delays: number[] = [];
    const child = {
      exitCode: null,
      once: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () => clients.shift() ?? fakeClient({}),
      transportFactory: fakeTransport,
      spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      sleep: async (durationMs) => {
        delays.push(durationMs);
      },
    });

    await driver.callTool("get_screen_size", {});
    expect(delays).toEqual([250, 500, 1_000]);
  });

  it("keeps polling the full budget even after the spawned child exits", async () => {
    const delays: number[] = [];
    const child = {
      exitCode: null,
      once: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () =>
        fakeClient({
          connect: async () => {
            throw new Error("daemon absent");
          },
        }),
      transportFactory: fakeTransport,
      spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      sleep: async (durationMs) => {
        delays.push(durationMs);
        (child as { exitCode: number | null }).exitCode = 3;
      },
    });

    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow(
      /COMPUTER_DRIVER_UNAVAILABLE: cua-driver daemon did not become ready in time/,
    );
    // Child exit must not short-circuit the schedule.
    expect(delays).toEqual([250, 500, 1_000, 2_000, 3_000, 3_000]);
  });

  it("respawns the daemon when the remembered child was signal-terminated", async () => {
    // Two connect cycles: cycle 1 spawns child0 and caches a session whose
    // callTool then breaks; cycle 2 must spawn again because child0 was killed
    // by signal (exitCode null, signalCode set) rather than a clean exit.
    const clients = [
      fakeClient({
        connect: async () => {
          throw new Error("daemon absent");
        },
      }),
      fakeClient({ callToolThrows: true }),
      fakeClient({
        connect: async () => {
          throw new Error("daemon absent");
        },
      }),
      fakeClient({}),
    ];
    const spawned: Array<{ signalCode: string | null; exitCode: number | null }> = [];
    const spawnProcess = vi.fn(() => {
      const child = {
        exitCode: null,
        signalCode: null,
        once: vi.fn(),
        unref: vi.fn(),
        kill: vi.fn(),
      };
      spawned.push(child);
      return child as unknown as ChildProcess;
    });
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () => clients.shift() ?? fakeClient({}),
      transportFactory: fakeTransport,
      spawn: spawnProcess as unknown as typeof import("node:child_process").spawn,
      sleep: async () => {},
    });

    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow("transport closed");
    const firstChild = spawned[0];
    expect(firstChild).toBeDefined();
    firstChild!.signalCode = "SIGKILL";
    await expect(driver.callTool("get_desktop_state", {})).resolves.toBeDefined();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("respawns after the spawned child emits an async spawn error", async () => {
    // `error` can fire without `exit`, leaving exitCode/signalCode null; the
    // handler must still forget the child so the next connect respawns.
    const clients = [
      fakeClient({
        connect: async () => {
          throw new Error("daemon absent");
        },
      }),
      fakeClient({ callToolThrows: true }),
      fakeClient({
        connect: async () => {
          throw new Error("daemon absent");
        },
      }),
      fakeClient({}),
    ];
    const errorHandlers: Array<() => void> = [];
    const spawnProcess = vi.fn(() => {
      const child = {
        exitCode: null,
        signalCode: null,
        unref: vi.fn(),
        kill: vi.fn(),
        once: (event: string, cb: () => void) => {
          if (event === "error") {
            errorHandlers.push(cb);
          }
        },
      };
      return child as unknown as ChildProcess;
    });
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () => clients.shift() ?? fakeClient({}),
      transportFactory: fakeTransport,
      spawn: spawnProcess as unknown as typeof import("node:child_process").spawn,
      sleep: async () => {},
    });

    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow("transport closed");
    errorHandlers[0]?.();
    await expect(driver.callTool("get_desktop_state", {})).resolves.toBeDefined();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("connects to a shared daemon even when our serve child lost the startup race", async () => {
    const clients = [
      fakeClient({
        connect: async () => {
          throw new Error("daemon absent");
        },
      }),
      fakeClient({}),
    ];
    const child = {
      exitCode: null,
      once: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () => clients.shift() ?? fakeClient({}),
      transportFactory: fakeTransport,
      spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      // Our serve child exited (another client won the race), but the shared
      // daemon it collided with is now serving; the retry must still connect.
      sleep: async () => {
        (child as { exitCode: number | null }).exitCode = 1;
      },
    });

    await expect(driver.callTool("get_screen_size", {})).resolves.toBeDefined();
  });

  it("gives up with a readiness timeout after exhausting the backoff schedule", async () => {
    const delays: number[] = [];
    const child = {
      exitCode: null,
      once: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const driver = new CuaDriverClient({
      driverPath: "/opt/bin/cua-driver",
      env: { PATH: "/opt/bin" },
      access: () => {},
      clientFactory: () =>
        fakeClient({
          connect: async () => {
            throw new Error("daemon never ready");
          },
        }),
      transportFactory: fakeTransport,
      spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      sleep: async (durationMs) => {
        delays.push(durationMs);
      },
    });

    await expect(driver.callTool("get_screen_size", {})).rejects.toThrow(
      /COMPUTER_DRIVER_UNAVAILABLE: cua-driver daemon did not become ready in time/,
    );
    expect(delays).toEqual([250, 500, 1_000, 2_000, 3_000, 3_000]);
  });

  it("closes a connection that completes after disposal starts", async () => {
    let finishConnect = () => {};
    const connecting = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const client = fakeClient({ connect: async () => await connecting });
    const driver = createClient(client);

    const call = driver.callTool("get_screen_size", {});
    const disposal = driver.dispose();
    finishConnect();

    await expect(call).rejects.toThrow("cua-driver client is disposed");
    await disposal;
    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    expect(driver.isAvailable()).toBe(false);
  });

  it("caches binary resolution for one second", () => {
    let now = 0;
    const access = vi.fn(() => {});
    const driver = new CuaDriverClient({
      env: { PATH: "/one:/two" },
      now: () => now,
      access,
    });
    expect(driver.isAvailable()).toBe(true);
    expect(driver.isAvailable()).toBe(true);
    expect(access).toHaveBeenCalledTimes(1);
    now = 1_001;
    expect(driver.isAvailable()).toBe(true);
    expect(access).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when the binary cannot be resolved", () => {
    const driver = new CuaDriverClient({
      env: { PATH: "/missing" },
      access: () => {
        throw new Error("ENOENT");
      },
    });
    expect(driver.isAvailable()).toBe(false);
  });
});

describe("CuaDriverClient refusal mapping", () => {
  it("uses a structured refusal code and the first text block", async () => {
    const driver = createClient(
      fakeClient({
        result: {
          isError: true,
          content: [
            { type: "text", text: "desktop unavailable" },
            { type: "text", text: "ignored" },
          ],
          structuredContent: { code: "background_unavailable" },
        },
      }),
    );
    await expect(driver.callTool("click", {})).rejects.toThrow(
      "COMPUTER_REFUSED_background_unavailable: desktop unavailable",
    );
  });

  it("falls back to the generic driver error prefix", async () => {
    const driver = createClient(
      fakeClient({
        result: { isError: true, content: [{ type: "text", text: "bad input" }] },
      }),
    );
    await expect(driver.callTool("click", {})).rejects.toThrow("COMPUTER_DRIVER_ERROR: bad input");
  });
});
