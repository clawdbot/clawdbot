// Covers gateway port availability and diagnostics behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
let inspectPortUsages: typeof import("./ports-inspect.js").inspectPortUsages;
let ensurePortAvailable: typeof import("./ports.js").ensurePortAvailable;
let handlePortError: typeof import("./ports.js").handlePortError;
let PortInUseError: typeof import("./ports.js").PortInUseError;

const describeUnix = process.platform === "win32" ? describe.skip : describe;
const describeWindows = process.platform === "win32" ? describe : describe.skip;

type CommandResult = { stdout: string; stderr: string; code: number };
type CommandReply = CommandResult | Error;

const failedCommand = (): CommandResult => ({ stdout: "", stderr: "", code: 1 });
const commandOutput = (stdout: string, code = 0, stderr = ""): CommandResult => ({
  stdout,
  stderr,
  code,
});

async function resolveCommandReply(reply: CommandReply | undefined): Promise<CommandResult> {
  if (reply instanceof Error) {
    throw reply;
  }
  return reply ?? failedCommand();
}

function mockUnixCommands(params: {
  lsof?: CommandReply;
  ss?: CommandReply;
  commandLine?: string | ((pid: string | undefined) => string);
  user?: string;
  parentPid?: string;
}): void {
  runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
    const command = argv[0];
    if (typeof command !== "string") {
      return failedCommand();
    }
    if (command.includes("lsof")) {
      return resolveCommandReply(params.lsof);
    }
    if (command === "ss") {
      return resolveCommandReply(params.ss);
    }
    if (command === "ps") {
      if (argv.includes("command=") && params.commandLine !== undefined) {
        const value =
          typeof params.commandLine === "function"
            ? params.commandLine(argv[2])
            : params.commandLine;
        return commandOutput(`${value}\n`);
      }
      if (argv.includes("user=") && params.user !== undefined) {
        return commandOutput(`${params.user}\n`);
      }
      if (argv.includes("ppid=") && params.parentPid !== undefined) {
        return commandOutput(`${params.parentPid}\n`);
      }
    }
    return failedCommand();
  });
}

function mockWindowsCommands(params: {
  netstat: CommandReply;
  tasklist?: CommandReply;
  powershell?: CommandReply;
  wmic?: CommandReply;
}): void {
  setPlatform("win32");
  runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
    const command = argv[0];
    const reply =
      command === getWindowsSystem32ExePath("netstat.exe")
        ? params.netstat
        : command === getWindowsSystem32ExePath("tasklist.exe")
          ? params.tasklist
          : command === getWindowsPowerShellExePath()
            ? params.powershell
            : command === getWindowsWmicExePath()
              ? params.wmic
              : undefined;
    return resolveCommandReply(reply);
  });
}

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
    if (code === "EPERM" || code === "EACCES" || code === "EADDRNOTAVAIL") {
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

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

beforeAll(async () => {
  ({ inspectPortConnections, inspectPortUsage, inspectPortUsages } =
    await import("./ports-inspect.js"));
  ({ ensurePortAvailable, handlePortError, PortInUseError } = await import("./ports.js"));
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ports helpers", () => {
  it("keeps process inspection behind the busy-port diagnostics boundary", () => {
    const source = readFileSync(new URL("./ports.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/(?:import|export)[^;]+from "\.\/ports-inspect\.js"/u);
    expect(source).toContain('await import("./ports-inspect.js")');
  });

  it("ensurePortAvailable rejects when port busy", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0);
    if (!address) {
      return;
    }
    const port = address.port;
    await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(PortInUseError);
    await closeServer(server);
  });

  it("ensurePortAvailable rejects when an explicitly scoped IPv4 loopback is busy", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;
    await expect(ensurePortAvailable(port, "127.0.0.1")).rejects.toBeInstanceOf(PortInUseError);
    await closeServer(server);
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
  it("keeps only listener rows that can block a scoped bind", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;

    mockUnixCommands({
      lsof: commandOutput(
        `p111\ncgateway\nnTCP 127.0.0.1:${port} (LISTEN)\n` +
          `p222\ncother\nnTCP 127.0.0.2:${port} (LISTEN)\n`,
      ),
    });

    try {
      const result = await inspectPortUsage(port, { probeHosts: ["127.0.0.1"] });

      expect(result.status).toBe("busy");
      expect(result.listeners).toHaveLength(1);
      expect(result.listeners[0]).toMatchObject({
        pid: 111,
        address: `TCP 127.0.0.1:${port} (LISTEN)`,
      });
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    { probeHost: "127.0.0.1", unrelatedWildcard: "[::]" },
    { probeHost: "::1", unrelatedWildcard: "0.0.0.0" },
  ])(
    "does not attribute an opposite-family wildcard listener to $probeHost",
    async ({ probeHost, unrelatedWildcard }) => {
      const server = net.createServer();
      const address = await listenServer(server, 0, probeHost);
      if (!address) {
        return;
      }
      const port = address.port;

      mockUnixCommands({
        lsof: commandOutput(`p222\ncother\nnTCP ${unrelatedWildcard}:${port} (LISTEN)\n`),
      });

      try {
        const result = await inspectPortUsage(port, { probeHosts: [probeHost] });

        expect(result.status).toBe("busy");
        expect(result.listeners).toEqual([]);
      } finally {
        await closeServer(server);
      }
    },
  );

  it("ignores another interface when inspection is scoped to the gateway loopback", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.2");
    if (!address) {
      return;
    }
    const port = address.port;

    mockUnixCommands({
      lsof: commandOutput(`p${process.pid}\ncnode\nnTCP 127.0.0.2:${port} (LISTEN)\n`),
    });

    try {
      const allInterfaces = await inspectPortUsage(port);
      const gatewayLoopback = await inspectPortUsage(port, {
        probeHosts: ["127.0.0.1"],
      });

      expect(allInterfaces.status).toBe("busy");
      expect(gatewayLoopback).toMatchObject({
        status: "free",
        listeners: [],
        hints: [],
      });
    } finally {
      await closeServer(server);
    }
  });

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
      await closeServer(server);
    }
  });

  it("falls back to ss when lsof is unavailable", async () => {
    const server = net.createServer();
    const address = await listenServer(server, 0, "127.0.0.1");
    if (!address) {
      return;
    }
    const port = address.port;

    mockUnixCommands({
      lsof: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
      ss: commandOutput(
        `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${process.pid},fd=23))`,
      ),
      commandLine: "node /tmp/openclaw/dist/index.js gateway --port 18789",
      user: "debian",
      parentPid: "1",
    });

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.listeners.length).toBeGreaterThan(0);
      expect(result.listeners[0]?.pid).toBe(process.pid);
      expect(result.listeners[0]?.commandLine).toContain("openclaw");
      expect(result.errors).toBeUndefined();
    } finally {
      await closeServer(server);
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
    mockUnixCommands({
      lsof: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
      ss: commandOutput(
        'LISTEN 0 4096 127.0.0.1:18789 0.0.0.0:* users:(("openclaw",pid=123,fd=12))',
      ),
    });

    const result = await inspectPortUsage(1878);

    expect(result.listeners).toEqual([]);
  });

  it("matches ss listener on exact port within multi-listener output", async () => {
    mockUnixCommands({
      lsof: Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
      ss: commandOutput(
        [
          'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("app",pid=100,fd=3))',
          'LISTEN 0 4096 127.0.0.1:18789 0.0.0.0:* users:(("openclaw",pid=123,fd=12))',
          'LISTEN 0 4096 127.0.0.1:18790 0.0.0.0:* users:(("other",pid=456,fd=7))',
        ].join("\n"),
      ),
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      pid: 123,
      address: "127.0.0.1:18789",
    });
  });

  it("reports established gateway client connections from lsof", async () => {
    mockUnixCommands({
      lsof: commandOutput(
        "p111\ncnode\nnTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n" +
          "p222\ncnode\nnTCP 127.0.0.1:18789->127.0.0.1:50123 (ESTABLISHED)\n" +
          "p444\ncnode\nnTCP 127.0.0.1:50125->[::ffff:127.0.0.1]:18789 (ESTABLISHED)\n" +
          "p555\ncnode\nnTCP 127.0.0.1:50126->127.0.0.1:18789abc (ESTABLISHED)\n" +
          "p666\ncnode\nnTCP 127.0.0.1:50127->127.0.0.1:99999 (ESTABLISHED)\n" +
          "p333\ncBrowser\nnTCP 127.0.0.1:50124->198.51.100.7:18789 (ESTABLISHED)\n",
      ),
      commandLine: (pid) =>
        pid === "111"
          ? "node /tmp/newer-openclaw/dist/index.js logs --follow"
          : pid === "222"
            ? "node /tmp/older-openclaw/dist/index.js gateway run"
            : "browser https://example.invalid/",
      user: "tester",
      parentPid: "1",
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
    mockUnixCommands({
      lsof: commandOutput("p111\ncnode\nnTCP *:18789 (LISTEN)\nnTCP *:18789 (LISTEN)\n"),
      commandLine: "node /tmp/openclaw/dist/index.js gateway run",
      user: "tester",
      parentPid: "1",
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({
      pid: 111,
      address: "TCP *:18789 (LISTEN)",
    });
  });

  it("keeps single-port lsof listener inspection scoped to the requested port", async () => {
    mockUnixCommands({
      lsof: commandOutput("p111\ncnode\nnTCP *:18789 (LISTEN)\n"),
      commandLine: "node /tmp/openclaw/dist/index.js gateway run",
      user: "tester",
      parentPid: "1",
    });

    await inspectPortUsage(18789);

    const lsofCalls = runCommandWithTimeoutMock.mock.calls.filter(([argv]) => {
      const command = Array.isArray(argv) ? argv[0] : undefined;
      return typeof command === "string" && command.includes("lsof");
    });
    expect(lsofCalls).toHaveLength(1);
    const lsofArgv = lsofCalls[0]?.[0] as string[] | undefined;
    expect(lsofArgv?.[0]).toMatch(/lsof$/);
    expect(lsofArgv?.slice(1)).toEqual(["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-FpFcn"]);
  });

  it("batches Unix listener lsof inspection across same-cycle port checks", async () => {
    mockUnixCommands({
      lsof: commandOutput(
        "p111\ncnode\nnTCP *:18789 (LISTEN)\n" +
          "p222\ncdeno\nnTCP 127.0.0.1:19001 (LISTEN)\n" +
          "p333\ncnginx\nnTCP *:3000 (LISTEN)\n",
      ),
      commandLine: (pid) =>
        pid === "111"
          ? "node /tmp/openclaw/dist/index.js gateway run"
          : "deno run /tmp/openclaw/cli.ts",
      user: "tester",
      parentPid: "1",
    });

    const results = await inspectPortUsages([18789, 19001]);

    const lsofCalls = runCommandWithTimeoutMock.mock.calls.filter(([argv]) => {
      const command = Array.isArray(argv) ? argv[0] : undefined;
      return typeof command === "string" && command.includes("lsof");
    });
    expect(lsofCalls).toHaveLength(1);
    const lsofArgv = lsofCalls[0]?.[0] as string[] | undefined;
    expect(lsofArgv?.[0]).toMatch(/lsof$/);
    expect(lsofArgv?.slice(1)).toEqual(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpFcn"]);
    expect(results.get(18789)).toMatchObject({
      port: 18789,
      status: "busy",
      listeners: [
        expect.objectContaining({
          pid: 111,
          command: "node",
          address: "TCP *:18789 (LISTEN)",
          commandLine: "node /tmp/openclaw/dist/index.js gateway run",
        }),
      ],
    });
    expect(results.get(19001)).toMatchObject({
      port: 19001,
      status: "busy",
      listeners: [
        expect.objectContaining({
          pid: 222,
          command: "deno",
          address: "TCP 127.0.0.1:19001 (LISTEN)",
          commandLine: "deno run /tmp/openclaw/cli.ts",
        }),
      ],
    });
    expect(results.get(18789)?.detail).toBe("p111\ncnode\nnTCP *:18789 (LISTEN)");
    expect(results.get(19001)?.detail).toBe("p222\ncdeno\nnTCP 127.0.0.1:19001 (LISTEN)");
  });

  it("preserves malformed lsof pid records as unknown-pid listener diagnostics", async () => {
    mockUnixCommands({
      lsof: commandOutput(
        "p\ncnode\nnTCP *:18789 (LISTEN)\np111\ncbun\nnTCP 127.0.0.1:18789 (LISTEN)\n",
      ),
      commandLine: "bun /tmp/openclaw/dist/index.js gateway run",
      user: "tester",
      parentPid: "1",
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
    mockUnixCommands({
      lsof: commandOutput("p111abc\ncnode\nnTCP *:18789 (LISTEN)\n"),
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
    mockUnixCommands({
      lsof: commandOutput(
        "p111\ncnode\n" +
          "nTCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)\n" +
          "nTCP 127.0.0.1:50124->127.0.0.1:18789 (ESTABLISHED)\n",
      ),
      commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
      user: "tester",
      parentPid: "1",
    });

    const result = await inspectPortConnections(18789);

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
    mockUnixCommands({
      lsof: commandOutput("", 1, "lsof: not found\n"),
      ss: commandOutput(
        '0 0 127.0.0.1:50123 127.0.0.1:18789 users:(("node",pid=111,fd=12))\n' +
          '0 0 127.0.0.1:50124 198.51.100.7:18789 users:(("browser",pid=333,fd=9))\n',
      ),
      commandLine: (pid) =>
        pid === "111"
          ? "node /tmp/newer-openclaw/dist/index.js logs --follow"
          : "browser https://example.invalid/",
      user: "tester",
      parentPid: "1",
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
  it("classifies SSH through locale-independent tasklist CSV output", async () => {
    setPlatform("win32");
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (command === getWindowsSystem32ExePath("netstat.exe")) {
        return commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n");
      }
      if (command === getWindowsSystem32ExePath("tasklist.exe")) {
        return argv.includes("CSV")
          ? commandOutput('"ssh.exe","4242","Console","1","10,000 K"\r\n')
          : commandOutput("Abbildname: ssh.exe\r\n");
      }
      return failedCommand();
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.command).toBe("ssh.exe");
    expect(result.hints).toContain(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
    expect(result.hints).not.toContain("Another process is listening on this port.");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [getWindowsSystem32ExePath("tasklist.exe"), "/FI", "PID eq 4242", "/FO", "CSV", "/NH"],
      expect.anything(),
    );
  });

  it.each([
    {
      name: "accepts a quoted image name containing a comma",
      output: '"ssh,helper.exe","4242","Console","1","10,000 K"\r\n',
      command: "ssh,helper.exe",
    },
    {
      name: "rejects a row for a different PID",
      output: '"ssh.exe","4243","Console","1","10,000 K"\r\n',
      command: undefined,
    },
    {
      name: "rejects localized no-task information",
      output: "INFORMATION: Keine Tasks entsprechen den angegebenen Kriterien.\r\n",
      command: undefined,
    },
    {
      name: "rejects an unquoted row",
      output: "ssh.exe,4242,Console,1,10,000 K\r\n",
      command: undefined,
    },
    {
      name: "rejects a truncated quoted row",
      output: '"ssh.exe","4242"\r\n',
      command: undefined,
    },
  ])("$name", async ({ output, command }) => {
    mockWindowsCommands({
      netstat: commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"),
      tasklist: commandOutput(output),
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.command).toBe(command);
  });

  it.each([
    { name: "nonzero tasklist exit", tasklist: commandOutput("", 1, "access denied") },
    { name: "tasklist timeout", tasklist: new Error("tasklist timed out") },
  ])("keeps generic diagnostics after $name", async ({ tasklist }) => {
    mockWindowsCommands({
      netstat: commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"),
      tasklist,
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.command).toBeUndefined();
    expect(result.hints).toContain("Another process is listening on this port.");
  });

  it("preserves command-line classification when tasklist output is unavailable", async () => {
    mockWindowsCommands({
      netstat: commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"),
      tasklist: commandOutput("", 1),
      powershell: commandOutput(
        '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -L 18789:localhost:18789 host\r\n',
      ),
    });

    const result = await inspectPortUsage(18789);

    expect(result.hints).toContain(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
  });

  it("reports established gateway client connections from netstat", async () => {
    mockWindowsCommands({
      netstat: commandOutput(
        "  TCP    127.0.0.1:50123    127.0.0.1:18789    ESTABLISHED    4242\r\n" +
          "  TCP    127.0.0.1:50124    198.51.100.7:18789  ESTABLISHED    5000\r\n",
      ),
      tasklist: commandOutput('"node.exe","4242","Console","1","10,000 K"\r\n'),
      powershell: commandOutput(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js logs --follow\r\n',
      ),
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
    mockWindowsCommands({
      netstat: commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"),
      tasklist: commandOutput('"node.exe","4242","Console","1","10,000 K"\r\n'),
      powershell: commandOutput(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway run\r\n',
      ),
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
    mockWindowsCommands({
      netstat: commandOutput(
        "  TCP    127.0.0.1:18789    0.0.0.0:0        ABHOEREN       4242\r\n" +
          "  TCP    [::1]:18789        [::]:0           ABHOEREN       4243\r\n" +
          "  TCP    127.0.0.1:18789    127.0.0.1:0      ABHOEREN       8999\r\n" +
          "  TCP    127.0.0.1:18789    127.0.0.1:50123  HERGESTELLT    9000\r\n",
      ),
      tasklist: commandOutput(
        '"node.exe","4242","Console","1","10,000 K"\r\n' +
          '"node.exe","4243","Console","1","10,000 K"\r\n',
      ),
      powershell: commandOutput("node.exe C:\\openclaw\\dist\\index.js gateway run\r\n"),
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
    mockWindowsCommands({
      netstat: commandOutput(
        "  TCP    127.0.0.1:187890    0.0.0.0:0    LISTENING    9000\r\n" +
          "  TCP    [::1]:187890        [::]:0         LISTENING    9001\r\n",
      ),
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners).toEqual([]);
  });

  it("falls back to wmic when PowerShell cannot read the command line", async () => {
    mockWindowsCommands({
      netstat: commandOutput("  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"),
      tasklist: commandOutput('"node.exe","4242","Console","1","10,000 K"\r\n'),
      powershell: commandOutput("", 1, "access denied"),
      wmic: commandOutput("CommandLine=node.exe C:\\openclaw\\dist\\index.js gateway run\r\n"),
    });

    const result = await inspectPortUsage(18789);

    expect(result.listeners[0]?.commandLine).toContain("openclaw");
    const commandNames = runCommandWithTimeoutMock.mock.calls.map(([argv]) => argv[0]);
    expect(commandNames).toContain(getWindowsWmicExePath());
  });
});

describeWindows("native tasklist CSV contract", () => {
  it("emits a quoted image and exact PID row", () => {
    const result = spawnSync(
      getWindowsSystem32ExePath("tasklist.exe"),
      ["/FI", `PID eq ${process.pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^"[^"]+","${process.pid}",`, "m"));
  });
});
