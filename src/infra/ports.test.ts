import net from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      if (command === "netstat") {
        return {
          stdout:
            "  TCP    127.0.0.1:50123    127.0.0.1:18789    ESTABLISHED    4242\r\n" +
            "  TCP    127.0.0.1:50124    198.51.100.7:18789  ESTABLISHED    5000\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "tasklist") {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === "powershell") {
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
      if (command === "netstat") {
        return {
          stdout: "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "tasklist") {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === "powershell") {
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

  it("falls back to wmic when PowerShell cannot read the command line", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const [command] = argv;
      if (command === "netstat") {
        return {
          stdout: "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "tasklist") {
        return { stdout: "Image Name: node.exe\r\n", stderr: "", code: 0 };
      }
      if (command === "powershell") {
        return { stdout: "", stderr: "access denied", code: 1 };
      }
      if (command === "wmic") {
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
    expect(commandNames).toContain("wmic");
  });
});
