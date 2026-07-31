// Probes local ports and reports listener availability.
import net from "node:net";
import { isErrno } from "./errors.js";
import type { PortUsageStatus } from "./ports-types.js";

const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"];
export const LOOPBACK_PORT_PROBE_HOSTS = ["127.0.0.1"] as const;

type ListenOnPortParams = {
  /** TCP port to probe; `0` lets the OS allocate an available ephemeral port. */
  port: number;
  /** Optional host/interface to bind during the probe. */
  host?: string;
  /** Whether the probe should request an exclusive server handle from Node. */
  exclusive?: boolean;
};

/** Opens and closes an ephemeral listener, returning the allocated port. */
export function tryListenOnPort(params: ListenOnPortParams & { port: 0 }): Promise<number>;
/** Opens and closes a temporary listener to verify that an explicit port can be bound. */
export function tryListenOnPort(params: ListenOnPortParams): Promise<void>;
export async function tryListenOnPort(params: ListenOnPortParams): Promise<number | void> {
  const listenOptions: net.ListenOptions = { port: params.port };
  if (params.host) {
    listenOptions.host = params.host;
  }
  if (typeof params.exclusive === "boolean") {
    listenOptions.exclusive = params.exclusive;
  }
  return await new Promise<number | void>((resolve, reject) => {
    const tester = net
      .createServer()
      .once("error", (err) => reject(err))
      .once("listening", () => {
        const address = tester.address();
        if (!address || typeof address === "string") {
          tester.close(() => reject(new Error("expected TCP listener address")));
          return;
        }
        // Binding succeeded; close immediately so the real server can claim the same port.
        tester.close(() => resolve(params.port === 0 ? address.port : undefined));
      })
      .listen(listenOptions);
  });
}

async function probePortOnHost(port: number, host: string): Promise<PortUsageStatus | "skip"> {
  try {
    await tryListenOnPort({ port, host, exclusive: true });
    return "free";
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      return "busy";
    }
    if (
      isErrno(err) &&
      (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT" || err.code === "EACCES")
    ) {
      // EACCES on privileged ports means the process lacks permission to bind
      // to that specific interface, not that the port is in use.
      return "skip";
    }
    return "unknown";
  }
}

/** Checks selected local addresses without resolving listener diagnostics. */
export async function probePortUsage(
  port: number,
  probeHosts: readonly string[] = PORT_PROBE_HOSTS,
): Promise<PortUsageStatus> {
  let sawUnknown = false;
  for (const host of probeHosts) {
    const result = await probePortOnHost(port, host);
    if (result === "busy") {
      return "busy";
    }
    if (result === "unknown") {
      sawUnknown = true;
    }
  }
  return sawUnknown ? "unknown" : "free";
}
