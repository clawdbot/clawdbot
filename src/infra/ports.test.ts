// Covers gateway port availability and diagnostics behavior.
import net from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

let inspectPortConnections: typeof import("./ports-inspect.js").inspectPortConnections;
let inspectPortUsage: typeof import("./ports-inspect.js").inspectPortUsage;
let ensurePortAvailable: typeof import("./ports.js").ensurePortAvailable;
let handlePortError: typeof import("./ports.js").handlePortError;
let PortInUseError: typeof import("./ports.js").PortInUseError;

const describeUnix = process.platform === "win32" ? describe.skip : describe;

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

async function listenServer(
  server: net.Server,
  port: number,
  host?: string,
): Promise<net.AddressInfo | null> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (host) {
        server.listen(port, host, resolve);
        return;
      }
      server.listen(port, resolve);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return null;
    }
    throw err;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return address;
}

beforeAll(async () => {
  ({ inspectPortConnections, inspectPortUsage } = await import("./ports-inspect.js"));
  ({ ensurePortAvailable, handlePortError, PortInUseError } = await import("./ports.js"));
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ports helpers", () => {
  it("ensurePortAvailable rejects when port busy", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0);
    if (!address) {
      return;
    }
    const port = address.port;
    await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(PortInUseError);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("ensurePortAvailable rejects when an explicitly scoped IPv4 loopback is busy", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;
    await expect(ensurePortAvailable(port, "127.0.0.1")).rejects.toBeInstanceOf(PortInUseError);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("handlePortError exits nicely on EADDRINUSE", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    // Avoid slow OS port inspection; this test only cares about messaging + exit behavior.
    await handlePortError(new PortInUseError(1234, "details"), 1234, "context", runtime).catch(
      () => {},
    );
    const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
    expect(messages.join("\n")).toContain("context failed: port 1234 is already in use.");
    expect(messages.join("\n")).toContain("Resolve by stopping the process");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("prints an OpenClaw-specific hint when port details look like another OpenClaw instance", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };

    await handlePortError(
      new PortInUseError(18789, "node dist/index.js openclaw gateway"),
      18789,
      "gateway start",
      runtime,
    ).catch(() => {});

    const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
    expect(messages.join("\n")).toContain("another OpenClaw instance is already running");
  });
});

describeUnix("inspectPortUsage", () => {
  it("reports busy when lsof is missing but loopback listener exists", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;

    runCommandWithTimeoutMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
    );

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      const enoentErrors = (result.errors ?? []).filter((err) => err.includes("ENOENT"));
      expect(enoentErrors.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("falls back to ss when lsof is unavailable", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;

    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      }
      if (command === "ss") {
        return {
          stdout: `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${process.pid},fd=23))`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        if (argv.includes("command=")) {
          return {
            stdout: "node /tmp/openclaw/dist/index.js gateway --port 18789\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return {
            stdout: "debian\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("ppid=")) {
          return {
            stdout: "1\n",
            stderr: "",
            code: 0,
          };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.listeners.length).toBeGreaterThan(0);
      expect(result.listeners[0]?.pid).toBe(process.pid);
      expect(result.listeners[0]?.commandLine).toContain("openclaw");
      expect(result.errors).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("limits concurrent Unix process metadata lookups", async () => {
    const listenerCount = 25;
    let activeProcessLookups = 0;
    let maxConcurrentProcessLookups = 0;
    let processLookupCount = 0;
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout: Array.from(
            { length: listenerCount },
            (_, index) => `p${1_000 + index}\ncnode\nnTCP 127.0.0.1:18789 (LISTEN)`,
          ).join("\n"),
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        processLookupCount += 1;
        activeProcessLookups += 1;
        maxConcurrentProcessLookups = Math.max(maxConcurrentProcessLookups, activeProcessLookups);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
        activeProcessLookups -= 1;
        return { stdout: "value\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toHaveLength(listenerCount);
    expect(processLookupCount).toBe(listenerCount * 3);
    expect(maxConcurrentProcessLookups).toBeLessThan(processLookupCount);
    expect(maxConcurrentProcessLookups).toBeLessThanOrEqual(60);
  });

  it("does not match ss listener ports by substring", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      }
      if (command === "ss") {
        return {
          stdout: 'LISTEN 0 4096 127.0.0.1:18789 0.0.0.0:* users:(("openclaw",pid=123,fd=12))',
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(1878);

    expect(result.listeners).toEqual([]);
  });

  it("matches ss listener on exact port within multi-listener output", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      }
      if (command === "ss") {
        return {
          stdout: [
            'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("app",pid=100,fd=3))',
            'LISTEN 0 4096 127.0.0.1:18789 0.0.0.0:* users:(("openclaw",pid=123,fd=12))',
            'LISTEN 0 4096 127.0.0.1:18790 0.0.0.0:* users:(("other",pid=456,fd=7))',
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      pid: 123,
      address: "127.0.0.1:18789",
    });
  });

  it("reports established gateway client connections from lsof", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout:
            "p111\ncnode\nnTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n" +
            "p222\ncnode\nnTCP 127.0.0.1:18789->127.0.0.1:50123 (ESTABLISHED)\n" +
            "p444\ncnode\nnTCP 127.0.0.1:50125->[::ffff:127.0.0.1]:18789 (ESTABLISHED)\n" +
            "p555\ncnode\nnTCP 127.0.0.1:50126->127.0.0.1:18789abc (ESTABLISHED)\n" +
            "p666\ncnode\nnTCP 127.0.0.1:50127->127.0.0.1:99999 (ESTABLISHED)\n" +
            "p333\ncBrowser\nnTCP 127.0.0.1:50124->198.51.100.7:18789 (ESTABLISHED)\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        const pid = argv[2];
        if (argv.includes("command=")) {
          return {
            stdout:
              pid === "111"
                ? "node /tmp/newer-openclaw/dist/index.js logs --follow\n"
                : pid === "222"
                  ? "node /tmp/older-openclaw/dist/index.js gateway run\n"
                  : "browser https://example.invalid/\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return { stdout: "tester\n", stderr: "", code: 0 };
        }
        if (argv.includes("ppid=")) {
          return { stdout: "1\n", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toHaveLength(3);
    expect(result.connections[0]).toMatchObject({
      pid: 111,
      direction: "client",
      commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
    });
    expect(result.connections[1]).toMatchObject({
      pid: 222,
      direction: "server",
    });
    expect(result.connections[2]).toMatchObject({
      pid: 444,
      direction: "client",
    });
  });

  it("deduplicates repeated lsof listener records for one process address", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout: "p111\ncnode\nnTCP *:18789 (LISTEN)\nnTCP *:18789 (LISTEN)\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        if (argv.includes("command=")) {
          return {
            stdout: "node /tmp/openclaw/dist/index.js gateway run\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return { stdout: "tester\n", stderr: "", code: 0 };
        }
        if (argv.includes("ppid=")) {
          return { stdout: "1\n", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      pid: 111,
      address: "TCP *:18789 (LISTEN)",
    });
  });

  it("preserves malformed lsof pid records as unknown-pid listener diagnostics", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout: "p\ncnode\nnTCP *:18789 (LISTEN)\np111\ncbun\nnTCP 127.0.0.1:18789 (LISTEN)\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        if (argv.includes("command=")) {
          return {
            stdout: "bun /tmp/openclaw/dist/index.js gateway run\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return { stdout: "tester\n", stderr: "", code: 0 };
        }
        if (argv.includes("ppid=")) {
          return { stdout: "1\n", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.status).toBe("busy");
    expect(result.listeners).toHaveLength(2);
    expect(result.listeners[0]).toMatchObject({
      command: "node",
      address: "TCP *:18789 (LISTEN)",
    });
    expect(result.listeners[0]?.pid).toBeUndefined();
    expect(result.listeners[1]).toMatchObject({
      pid: 111,
      command: "bun",
      address: "TCP 127.0.0.1:18789 (LISTEN)",
    });
  });

  it("rejects lsof pid tokens with trailing garbage instead of truncating them", async () => {
    // Number.parseInt("111abc", 10) === 111, which would silently accept a
    // corrupted pid field. Keep the socket evidence without fabricating pid 111.
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout: "p111abc\ncnode\nnTCP *:18789 (LISTEN)\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.status).toBe("busy");
    expect(result.listeners).toEqual([
      {
        command: "node",
        address: "TCP *:18789 (LISTEN)",
      },
    ]);
    expect(result.hints).toContain("Another process is listening on this port.");
  });

  it("reports multiple lsof socket records for one process", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return {
          stdout:
            "p111\ncnode\n" +
            "nTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n" +
            "nTCP 127.0.0.1:50124->127.0.0.1:18789 (ESTABLISHED)\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        if (argv.includes("command=")) {
          return {
            stdout: "node /tmp/newer-openclaw/dist/index.js logs --follow\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return { stdout: "tester\n", stderr: "", code: 0 };
        }
        if (argv.includes("ppid=")) {
          return { stdout: "1\n", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toHaveLength(2);
    expect(result.connections).toEqual([
      expect.objectContaining({
        pid: 111,
        direction: "client",
        address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
      }),
      expect.objectContaining({
        pid: 111,
        direction: "client",
        address: "TCP 127.0.0.1:50124->127.0.0.1:18789 (ESTABLISHED)",
      }),
    ]);
  });

  it("falls back to ss for established gateway client connections", async () => {
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        return { stdout: "", stderr: "lsof: not found\n", code: 1 };
      }
      if (command === "ss") {
        return {
          stdout:
            '0 0 127.0.0.1:50123 127.0.0.1:18789 users:(("node",pid=111,fd=12))\n' +
            '0 0 127.0.0.1:50124 198.51.100.7:18789 users:(("browser",pid=333,fd=9))\n',
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        const pid = argv[2];
        if (argv.includes("command=")) {
          return {
            stdout:
              pid === "111"
                ? "node /tmp/newer-openclaw/dist/index.js logs --follow\n"
                : "browser https://example.invalid/\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return { stdout: "tester\n", stderr: "", code: 0 };
        }
        if (argv.includes("ppid=")) {
          return { stdout: "1\n", stderr: "", code: 0 };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      pid: 111,
      direction: "client",
      commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
    });
  });
});

describe("inspectPortUsage on Windows", () => {
  it("reports established gateway client connections from netstat", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return {
          stdout:
            "  TCP    127.0.0.1:50123    127.0.0.1:18789    ESTABLISHED    4242\r\n" +
            "  TCP    127.0.0.1:50124    198.51.100.7:18789  ESTABLISHED    5000\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === getWindowsSystem32ExePath("tasklist.exe")) {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === getWindowsPowerShellExePath()) {
        return {
          stdout:
            '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js logs --follow\r\n',
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortConnections(18789);

    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      pid: 4242,
      command: "node.exe",
      direction: "client",
    });
    expect(result.connections[0]?.commandLine).toContain("openclaw");
  });

  it("uses PowerShell process command lines to classify OpenClaw listeners", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return {
          stdout: "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === getWindowsSystem32ExePath("tasklist.exe")) {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === getWindowsPowerShellExePath()) {
        return {
          stdout:
            '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway run\r\n',
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.status).toBe("busy");
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]?.command).toBe("node.exe");
    expect(result.listeners[0]?.commandLine).toContain("openclaw");
    expect(result.hints.some((hint) => hint.includes("Gateway already running locally"))).toBe(
      false,
    );
  });

  it("reports localized Windows listener rows without requiring English state text", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return {
          stdout:
            "  TCP    127.0.0.1:18789    0.0.0.0:0        ABHOEREN       4242\r\n" +
            "  TCP    [::1]:18789        [::]:0           ABHOEREN       4243\r\n" +
            "  TCP    127.0.0.1:18789    127.0.0.1:0      ABHOEREN       8999\r\n" +
            "  TCP    127.0.0.1:18789    127.0.0.1:50123  HERGESTELLT    9000\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === getWindowsSystem32ExePath("tasklist.exe")) {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === getWindowsPowerShellExePath()) {
        return {
          stdout: "node.exe C:\\openclaw\\dist\\index.js gateway run\r\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.status).toBe("busy");
    expect(result.listeners.map((listener) => listener.pid)).toEqual([4242, 4243]);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [getWindowsSystem32ExePath("netstat.exe"), "-ano"],
      expect.anything(),
    );
  });

  it("does not match Windows listener ports by substring", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return {
          stdout:
            "  TCP    127.0.0.1:187890    0.0.0.0:0    LISTENING    9000\r\n" +
            "  TCP    [::1]:187890        [::]:0         LISTENING    9001\r\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toEqual([]);
  });

  it("falls back to wmic when PowerShell cannot read the command line", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return {
          stdout: "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === getWindowsSystem32ExePath("tasklist.exe")) {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === getWindowsPowerShellExePath()) {
        return { stdout: "", stderr: "access denied", code: 1 };
      }
      if (command === getWindowsWmicExePath()) {
        return {
          stdout: "CommandLine=node.exe C:\\openclaw\\dist\\index.js gateway run\r\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.commandLine).toContain("openclaw");
    const commandNames = runCommandWithTimeoutMock.mock.calls.map(([argv]) => argv[0]);
    expect(commandNames).toContain(getWindowsWmicExePath());
  });
});
