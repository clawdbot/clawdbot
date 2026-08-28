import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import * as hostSource from "../gateway/desktop/host-source.js";
import { collectHostDesktopHealthFindings, noteHostDesktopHealth } from "./doctor-host-desktop.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.mocked(note).mockReset();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const unavailableInspection: hostSource.HostDesktopInspection = {
  status: { enabled: true, state: "unavailable", port: 5900 },
  detail:
    "gateway host desktop is unavailable at 127.0.0.1:5900. Enable System Settings -> General -> Sharing -> Screen Sharing.",
  unavailableReason: "not-listening",
};

function commandResult(code: number) {
  return {
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("host desktop doctor section", () => {
  it("reports the disabled Labs toggle", async () => {
    await noteHostDesktopHealth({});
    expect(note).toHaveBeenCalledWith(
      "disabled; enable the Desktop lab with desktop.host.enabled=true, then restart the gateway",
      "Host desktop",
    );
  });

  it("reports an attached VncAuth loopback server without password material", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected RFB address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resolve());
        }),
    );

    await noteHostDesktopHealth({ desktop: { host: { enabled: true, port: address.port } } });
    expect(note).toHaveBeenCalledWith(
      `attached (127.0.0.1:${address.port}, security: VncAuth)`,
      "Host desktop",
    );
  });

  it("reports managed configured and failed states distinctly", async () => {
    vi.spyOn(hostSource, "inspectHostDesktop")
      .mockResolvedValueOnce({
        status: {
          enabled: true,
          state: "managed",
          managedState: "unknown",
          port: 5900,
        },
        detail: "managed (configured; runtime state is available from the running Gateway status)",
      })
      .mockResolvedValueOnce({
        status: {
          enabled: true,
          state: "managed",
          managedState: "failed",
          port: 46_001,
          display: 99,
          error: "startxfce4 not installed",
        },
        detail: "managed (failed: startxfce4 not installed)",
      });

    await noteHostDesktopHealth(
      { desktop: { host: { enabled: true, managed: true } } },
      { platform: "linux" },
    );
    expect(note).toHaveBeenCalledWith(
      "managed (configured; runtime state is available from the running Gateway status)",
      "Host desktop",
    );
    await expect(
      collectHostDesktopHealthFindings({
        desktop: { host: { enabled: true, managed: true } },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        severity: "warning",
        message: "managed (failed: startxfce4 not installed)",
      }),
    ]);
  });

  it("runs the exact Screen Sharing launchctl repair only after interactive confirmation", async () => {
    vi.spyOn(hostSource, "inspectHostDesktop")
      .mockResolvedValueOnce(unavailableInspection)
      .mockResolvedValueOnce({
        status: { enabled: true, state: "attached", port: 5900, security: "ARD" },
        detail: "attached (127.0.0.1:5900, security: ARD)",
      });
    const confirmRuntimeRepair = vi.fn(async () => true);
    const runCommand = vi.fn(async (_argv: string[], _options: unknown) => commandResult(0));

    await noteHostDesktopHealth(
      { desktop: { host: { enabled: true } } },
      {
        platform: "darwin",
        prompter: { shouldRepair: true, confirmRuntimeRepair },
        runCommand,
      },
    );

    expect(confirmRuntimeRepair).toHaveBeenCalledWith({
      message:
        "Enable macOS Screen Sharing now using sudo launchctl? This system service may accept connections from other network interfaces according to macOS Sharing settings.",
      initialValue: false,
      requiresInteractiveConfirmation: true,
    });
    expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([
      ["sudo", "launchctl", "enable", "system/com.apple.screensharing"],
      ["sudo", "launchctl", "kickstart", "-k", "system/com.apple.screensharing"],
    ]);
    expect(note).toHaveBeenCalledWith("attached (127.0.0.1:5900, security: ARD)", "Host desktop");
  });

  it("prints the System Settings path when interactive repair is declined", async () => {
    vi.spyOn(hostSource, "inspectHostDesktop").mockResolvedValue(unavailableInspection);
    const runCommand = vi.fn();
    await noteHostDesktopHealth(
      { desktop: { host: { enabled: true } } },
      {
        platform: "darwin",
        prompter: { shouldRepair: true, confirmRuntimeRepair: vi.fn(async () => false) },
        runCommand: runCommand as never,
      },
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "Enable Screen Sharing manually in System Settings → General → Sharing → Screen Sharing.",
      "Host desktop repair",
    );
  });

  it("stops after a failed sudo command and prints both manual repair paths", async () => {
    vi.spyOn(hostSource, "inspectHostDesktop").mockResolvedValue(unavailableInspection);
    const runCommand = vi.fn(async () => commandResult(1));
    await noteHostDesktopHealth(
      { desktop: { host: { enabled: true } } },
      {
        platform: "darwin",
        prompter: { shouldRepair: true, confirmRuntimeRepair: vi.fn(async () => true) },
        runCommand,
      },
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "sudo launchctl enable system/com.apple.screensharing && sudo launchctl kickstart -k system/com.apple.screensharing",
      ),
      "Host desktop repair",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("System Settings → General → Sharing → Screen Sharing"),
      "Host desktop repair",
    );
  });
});
