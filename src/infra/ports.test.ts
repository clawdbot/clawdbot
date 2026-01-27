import net from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  buildPortHints,
  classifyPortListener,
  ensurePortAvailable,
  formatPortDiagnostics,
  handlePortError,
  PortInUseError,
} from "./ports.js";

describe("ports helpers", () => {
  it("ensurePortAvailable rejects when port busy", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;
    await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(PortInUseError);
    server.close();
  });

  it("handlePortError exits nicely on EADDRINUSE", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    await handlePortError({ code: "EADDRINUSE" }, 1234, "context", runtime).catch(() => {});
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("classifies ssh and gateway listeners", () => {
    expect(
      classifyPortListener({ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, 18789),
    ).toBe("ssh");
    expect(
      classifyPortListener(
        {
          commandLine: "node /Users/me/Projects/moltbot/dist/entry.js gateway",
        },
        18789,
      ),
    ).toBe("gateway");
  });

  it("formats port diagnostics with hints", () => {
    const diagnostics = {
      port: 18789,
      status: "busy" as const,
      listeners: [{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }], 18789),
    };
    const lines = formatPortDiagnostics(diagnostics);
    expect(lines[0]).toContain("Port 18789 is already in use");
    expect(lines.some((line) => line.includes("SSH tunnel"))).toBe(true);
  });
});
