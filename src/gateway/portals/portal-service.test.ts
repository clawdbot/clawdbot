import { request } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

const services = new Set<GatewayPortalService>();

afterEach(async () => {
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

async function expectConnectionRefused(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`listener ${port} remained open`));
    });
    socket.once("error", () => resolve());
  });
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
    const second = await service.open({ targetPort: 4000 });

    await service.close(first.id);
    await service.close(first.id);
    expect(service.list().map((entry) => entry.id)).toEqual([second.id]);
    await expectConnectionRefused(first.listenPort);

    await service.closeAll();
    expect(service.list()).toEqual([]);
    expect(httpServers).toEqual([]);
    await expectConnectionRefused(second.listenPort);
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
