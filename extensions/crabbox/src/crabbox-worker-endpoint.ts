import net from "node:net";
import type { WorkerLease } from "openclaw/plugin-sdk/plugin-entry";

const TCP_PROBE_TIMEOUT_MS = 4_000;

export type TcpProbe = (host: string, port: number) => Promise<boolean>;

export async function probeTcpPort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), TCP_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function selectSshEndpoint(
  lease: WorkerLease,
  fallbackPorts: readonly number[],
  probe: TcpProbe,
): Promise<WorkerLease> {
  for (const port of [lease.ssh.port, ...fallbackPorts]) {
    if (await probe(lease.ssh.host, port)) {
      return port === lease.ssh.port ? lease : { ...lease, ssh: { ...lease.ssh, port } };
    }
  }
  throw new Error(
    "Crabbox reported no TCP-reachable SSH port; allow at least one configured SSH candidate through the Gateway network policy",
  );
}
