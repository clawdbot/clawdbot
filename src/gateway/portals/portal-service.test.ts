import { request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "../../test-utils/ports.js";
import * as httpListen from "../server/http-listen.js";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

const services = new Set<GatewayPortalService>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...services].map((service) => service.closeAll()));
  services.clear();
});

function makeService(hosts: string[]) {
  const httpServers: import("node:http").Server[] = [];
  const service = createGatewayPortalService({ httpBindHosts: hosts, httpServers });
  services.add(service);
  return { service, httpServers };
}

async function getStatus(host: string, port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const req = request({ host, port, path }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

async function getDistinctFreePort(excluded: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await getFreePort();
    if (port !== excluded) {
      return port;
    }
  }
  throw new Error("Failed to reserve a distinct test port");
}

describe("gateway portal service", () => {
  it("allocates one port across every frozen bind host", async () => {
    const { service, httpServers } = makeService(["127.0.0.1", "::1"]);
    const portal = await service.open({ targetPort: 3000, title: "App" });

    expect(portal).toMatchObject({ id: "p3000", port: 3000, title: "App" });
    expect(portal.listenPort).toBeGreaterThan(0);
    expect(httpServers).toHaveLength(2);
    expect(await getStatus("127.0.0.1", portal.listenPort, "/")).toBe(401);
    expect(await getStatus("::1", portal.listenPort, "/")).toBe(401);
  });

  it("retries a target-port collision before binding sibling hosts", async () => {
    const targetPort = await getFreePort();
    const acceptedPort = await getDistinctFreePort(targetPort);
    const actualListen = httpListen.listenGatewayHttpServer;
    const calls: Array<{ host: string; port: number }> = [];
    let primaryAttempt = 0;
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      calls.push({ host: params.bindHost, port: params.port });
      if (params.bindHost === "127.0.0.1" && params.port === 0) {
        primaryAttempt += 1;
        await actualListen({
          ...params,
          port: primaryAttempt === 1 ? targetPort : acceptedPort,
        });
        return;
      }
      await actualListen(params);
    });
    const { service, httpServers } = makeService(["127.0.0.1", "::1"]);

    const portal = await service.open({ targetPort });

    expect(portal.listenPort).toBe(acceptedPort);
    expect(calls).toEqual([
      { host: "127.0.0.1", port: 0 },
      { host: "127.0.0.1", port: 0 },
      { host: "::1", port: acceptedPort },
    ]);
    expect(httpServers).toHaveLength(2);
    expect(httpServers.every((server) => server.listening)).toBe(true);
    expect(await getStatus("127.0.0.1", portal.listenPort, `/?${portal.tokenQuery}`)).toBe(502);

    const ownedServers = [...httpServers];
    await service.closeAll();
    expect(httpServers).toEqual([]);
    expect(ownedServers.every((server) => !server.listening && server.address() === null)).toBe(
      true,
    );
  });

  it("cleans up when every allocation collides with the target port", async () => {
    const targetPort = await getFreePort();
    const actualListen = httpListen.listenGatewayHttpServer;
    const attemptedServers = new Set<Server>();
    const listen = vi
      .spyOn(httpListen, "listenGatewayHttpServer")
      .mockImplementation(async (params) => {
        attemptedServers.add(params.httpServer);
        await actualListen({ ...params, port: targetPort });
      });
    const { service, httpServers } = makeService(["127.0.0.1"]);

    await expect(service.open({ targetPort })).rejects.toThrow(
      `Portal listener repeatedly allocated target port ${targetPort}`,
    );

    expect(listen).toHaveBeenCalledTimes(10);
    expect(attemptedServers.size).toBe(1);
    expect(httpServers).toEqual([]);
    const [primaryServer] = attemptedServers;
    expect(primaryServer?.listening).toBe(false);
    expect(primaryServer?.address()).toBeNull();
  });

  it("updates an existing target without replacing its listener or token", async () => {
    const { service, httpServers } = makeService(["127.0.0.1"]);
    const first = await service.open({ targetPort: 3000, title: "First" });
    const second = await service.open({
      targetPort: 3000,
      title: "Second",
      description: "Updated",
      path: "/preview",
    });

    expect(second).toMatchObject({
      id: first.id,
      listenPort: first.listenPort,
      tokenQuery: first.tokenQuery,
      title: "Second",
      description: "Updated",
      path: "/preview",
      publicUrl: `http://127.0.0.1:${first.listenPort}/preview`,
    });
    expect(second.url).toBe(`${second.publicUrl}?${second.tokenQuery}`);
    expect(httpServers).toHaveLength(1);
    expect(service.list()).toEqual([second]);
  });

  it("closes idempotently and closes every portal on shutdown", async () => {
    const { service, httpServers } = makeService(["127.0.0.1"]);
    const first = await service.open({ targetPort: 3000 });
    const firstServer = httpServers.at(-1);
    const second = await service.open({ targetPort: 4000 });
    const secondServer = httpServers.at(-1);
    expect(firstServer).toBeDefined();
    expect(secondServer).toBeDefined();

    await service.close(first.id);
    await service.close(first.id);
    expect(service.list().map((entry) => entry.id)).toEqual([second.id]);
    // A closed ephemeral port can be reassigned immediately to a parallel test.
    // Assert the owned Server instead of probing whichever listener now owns its port.
    expect(firstServer?.listening).toBe(false);
    expect(firstServer?.address()).toBeNull();

    await service.closeAll();
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    expect(secondServer?.listening).toBe(false);
    expect(secondServer?.address()).toBeNull();
  });

  it("removes every registered listener after a partial bind failure", async () => {
    const { service, httpServers } = makeService(["127.0.0.1", "127.0.0.1"]);

    await expect(service.open({ targetPort: 3000 })).rejects.toThrow(/already listening/u);
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
  });

  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
  ])("maps wildcard bind host %s to openable host %s", async (bindHost, openableHost) => {
    const { service } = makeService([bindHost]);
    const portal = await service.open({ targetPort: 3000 });

    expect(portal.publicUrl).toBe(`http://${openableHost}:${portal.listenPort}/`);
    expect(portal.url).toBe(`${portal.publicUrl}?${portal.tokenQuery}`);
  });
});
