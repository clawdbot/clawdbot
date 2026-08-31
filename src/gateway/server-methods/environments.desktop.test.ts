import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { HostDesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { createHostDesktopService } from "../desktop/host-source.js";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "../desktop/node-source-context.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import { environmentsHandlers } from "./environments.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function invoke(
  method: "desktop.observe" | "worker.desktop.observe",
  params: unknown,
  context: object,
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({ params, respond, context } as never);
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected desktop handler response");
  }
  return call;
}

describe("desktop gateway methods", () => {
  it("names the Labs config and restart when host desktop is disabled", async () => {
    const [ok, , error] = await invoke(
      "desktop.observe",
      { source: { kind: "host" } },
      { getRuntimeConfig: () => ({}) },
    );
    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message:
        "gateway host desktop is disabled; enable the Desktop lab (config: desktop.host.enabled=true), then restart the gateway",
    });
  });

  it("returns a host observer token and auth from a real loopback RFB server", async () => {
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
    const registry = createDesktopSessionRegistry({ lingerMs: 10 });
    cleanups.push(async () => registry.stopAll());
    const config = { enabled: true, port: address.port };
    const [ok, result] = await invoke(
      "desktop.observe",
      { source: { kind: "host" }, control: true },
      {
        getRuntimeConfig: () => ({ desktop: { host: config } }),
        hostDesktopService: createHostDesktopService({ config, registry }),
      },
    );
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      transport: "rfb",
      control: true,
      auth: "vnc-password",
    });
    expect(result.wsPath).toMatch(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u);
  });

  it("keeps the worker alias identical to the generic environment arm", async () => {
    const workerEnvironmentService = {
      observeDesktop: vi.fn(async ({ control }: { control: boolean }) => ({
        transport: "rfb" as const,
        wsPath: "/desktop/observe?token=fixed",
        expiresAtMs: 42,
        control,
        vncPassword: "password",
      })),
    };
    const context = { workerEnvironmentService };
    const alias = await invoke(
      "worker.desktop.observe",
      { environmentId: "worker:one", control: false },
      context,
    );
    const generic = await invoke(
      "desktop.observe",
      { source: { kind: "environment", environmentId: "worker:one" }, control: false },
      context,
    );
    expect(alias).toEqual(generic);
    expect(alias[1]).not.toHaveProperty("auth");
  });

  it("reports ARD credentials as required and forwards an in-memory retry", async () => {
    const observe = vi.fn(
      async (params: { credentials?: { username?: string; password?: string } }) => {
        if (!params.credentials) {
          throw new HostDesktopCredentialsRequiredError();
        }
        return {
          transport: "rfb" as const,
          wsPath: "/desktop/observe?token=fixed",
          expiresAtMs: 42,
          control: false,
          auth: "ard-account" as const,
        };
      },
    );
    const context = {
      getRuntimeConfig: () => ({ desktop: { host: { enabled: true } } }),
      hostDesktopService: {
        observe,
        status: async () => ({ enabled: true, state: "attached", port: 5900, security: "VncAuth" }),
      },
    };
    const [firstOk, , firstError] = await invoke(
      "desktop.observe",
      { source: { kind: "host" } },
      context,
    );
    expect(firstOk).toBe(false);
    expect(firstError).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      details: {
        code: "DESKTOP_CREDENTIALS_REQUIRED",
        auth: "ard-account",
      },
    });

    const credentials = { username: "operator", password: "account-password" };
    const [retryOk, result] = await invoke(
      "desktop.observe",
      { source: { kind: "host" }, credentials },
      context,
    );
    expect(retryOk).toBe(true);
    expect(result).toMatchObject({ auth: "ard-account" });
    expect(result).not.toHaveProperty("vncPassword");
    expect(observe).toHaveBeenLastCalledWith({ control: false, credentials });
  });

  it("rejects unknown desktop source kinds before dispatch", async () => {
    const [ok, , error] = await invoke("desktop.observe", { source: { kind: "future" } }, {});
    expect(ok).toBe(false);
    expect(error.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("forwards node credentials only to the paired-node desktop service", async () => {
    const observe = vi.fn(async () => ({
      transport: "rfb" as const,
      wsPath: "/desktop/observe?token=node",
      expiresAtMs: 42,
      control: false,
      auth: "vnc-password" as const,
    }));
    const credentials = { password: "memory-only-node-password" };
    const [ok, result] = await invoke(
      "desktop.observe",
      { source: { kind: "node", nodeId: "node-1" }, credentials },
      { [NODE_DESKTOP_SERVICE_CONTEXT]: { observe } },
    );
    expect(ok).toBe(true);
    expect(result).not.toHaveProperty("vncPassword");
    expect(observe).toHaveBeenCalledWith({
      nodeId: "node-1",
      control: false,
      credentials,
    });
  });
});
