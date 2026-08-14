import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  createHostDesktopService,
  createHostDesktopSource,
  inspectHostDesktop,
} from "./host-source.js";
import type { ManagedLinuxDesktop } from "./managed-linux.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listenRfb(params: { banner?: string; securityTypes?: number[] }) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.write(Buffer.from(params.banner ?? "RFB 003.008\n", "ascii"));
    if (params.securityTypes) {
      socket.once("data", () => {
        socket.write(Buffer.from([params.securityTypes!.length, ...params.securityTypes!]));
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB server address");
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
  return address.port;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

function fakeManagedDesktop(
  status: ReturnType<ManagedLinuxDesktop["status"]> = { state: "not-started" },
) {
  const acquire = vi.fn(async () => ({
    attachment: { kind: "tcp" as const, host: "127.0.0.1" as const, port: 46_001 },
    auth: "vnc-password" as const,
    vncPassword: "managed-secret",
  }));
  const stop = vi.fn(async () => undefined);
  const managed: ManagedLinuxDesktop = { acquire, stop, status: () => status };
  return { acquire, managed, stop };
}

describe("gateway host desktop source", () => {
  it("refuses an unauthenticated VNC server", async () => {
    const port = await listenRfb({ securityTypes: [1] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `refusing unauthenticated VNC server on 127.0.0.1:${port}`,
    );
  });

  it("returns a loopback attachment and redacted password-file value for VncAuth", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-desktop-"));
    const passwordFile = path.join(root, "passwd");
    const password = "desktop-secret";
    await fs.writeFile(passwordFile, `${password}\n`);
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

    const source = createHostDesktopSource({
      config: { enabled: true, port, passwordFile },
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
      vncPassword: password,
    });
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);
  });

  it("keeps the VncAuth credential prompt path when passwordFile is omitted", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
  });

  it("attaches ARD and keeps account credentials only in the observer token", async () => {
    const port = await listenRfb({ banner: "RFB 003.889\n", securityTypes: [30] });
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "darwin",
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "ard-account",
    });

    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      config: { enabled: true, port },
      platform: "darwin",
      registry,
    });
    cleanups.push(async () => registry.stopAll());
    await expect(service.observe({ control: false })).rejects.toThrow(
      "macOS account credentials are required",
    );
    const password = "mac-account-password";
    const observed = await service.observe({
      control: false,
      credentials: { username: "operator", password },
    });
    expect(observed).toMatchObject({ auth: "ard-account", control: false });
    expect(observed).not.toHaveProperty("vncPassword");
    expect(observed.wsPath).toMatch(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u);
    expect(observed.wsPath).not.toContain("operator");
    expect(observed.wsPath).not.toContain(password);
    expect(isSecretValueRegisteredForRedaction(password)).toBe(true);

    await expect(
      inspectHostDesktop({ config: { enabled: true, port }, platform: "darwin" }),
    ).resolves.toMatchObject({
      status: { state: "attached", security: "ARD" },
      detail: `attached (127.0.0.1:${port}, security: ARD)`,
    });
  });

  it("still refuses VeNCrypt", async () => {
    const port = await listenRfb({ securityTypes: [19] });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow("VeNCrypt is not supported");
  });

  it("reports a non-VNC occupant and the port config next step", async () => {
    const port = await listenRfb({ banner: "HTTP/1.1 200" });
    const source = createHostDesktopSource({ config: { enabled: true, port } });
    await expect(source.acquire()).rejects.toThrow(
      `desktop.host.port ${port} is occupied by a non-VNC service; configure desktop.host.port`,
    );
  });

  it("reports unreachable Linux setup guidance", async () => {
    const port = await unusedPort();
    const source = createHostDesktopSource({
      config: { enabled: true, port },
      platform: "linux",
    });
    await expect(source.acquire()).rejects.toThrow("apt install tigervnc-standalone-server");
  });

  it("keeps an explicitly configured port ahead of managed mode", async () => {
    const port = await listenRfb({ securityTypes: [2] });
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true, port },
      platform: "linux",
      managedDesktop: managed.managed,
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
  });

  it("keeps a default-port RFB listener ahead of managed mode", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "rfb", securityTypes: [2] }),
    });
    await expect(source.acquire()).resolves.toEqual({
      attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
      auth: "vnc-password",
    });
    expect(managed.acquire).not.toHaveBeenCalled();
  });

  it("starts managed mode only on Linux after the default port is unreachable", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "linux",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
    await expect(source.acquire()).resolves.toMatchObject({
      attachment: { host: "127.0.0.1", port: 46_001 },
      auth: "vnc-password",
    });
    expect(managed.acquire).toHaveBeenCalledOnce();
  });

  it("reports managed mode as Linux-only on other platforms", async () => {
    const managed = fakeManagedDesktop();
    const source = createHostDesktopSource({
      config: { enabled: true, managed: true },
      platform: "darwin",
      managedDesktop: managed.managed,
      probeRfb: async () => ({ kind: "unreachable" }),
    });
    await expect(source.acquire()).rejects.toThrow(
      "desktop.host.managed is available only on Linux",
    );
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "darwin",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toMatchObject({
      status: { state: "unavailable" },
      detail: expect.stringContaining("available only on Linux"),
    });
  });

  it("reports managed lifecycle states without exposing password material", async () => {
    const managed = fakeManagedDesktop({ state: "running", display: 99, port: 46_001 });
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        managedDesktop: managed.managed,
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "running",
        display: 99,
        port: 46_001,
        security: "VncAuth",
      },
      detail: "managed (running, display :99, port 46001, security: VncAuth)",
    });
  });

  it("does not infer process-local managed state from standalone inspection", async () => {
    await expect(
      inspectHostDesktop({
        config: { enabled: true, managed: true },
        platform: "linux",
        probeRfb: async () => ({ kind: "unreachable" }),
      }),
    ).resolves.toEqual({
      status: {
        enabled: true,
        state: "managed",
        managedState: "unknown",
        port: 5900,
      },
      detail: "managed (configured; runtime state is available from the running Gateway status)",
    });
  });
});
