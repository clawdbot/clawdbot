// Probes local ports and reports listener availability.
import net from "node:net";
import { isErrno } from "./errors.js";
import type { PortUsageStatus } from "./ports-types.js";

const PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"];

/** Opens and closes a temporary listener to verify that a port can be bound. */
export async function tryListenOnPort(params: {
  /** TCP port to probe; `0` lets the OS allocate an available ephemeral port. */
  port: number;
  /** Optional host/interface to bind during the probe. */
  host?: string;
  /** Whether the probe should request an exclusive server handle from Node. */
  exclusive?: boolean;
}): Promise<void> {
  const listenOptions: net.ListenOptions = { port: params.port };
  if (params.host) {
    listenOptions.host = params.host;
  }
  if (typeof params.exclusive === "boolean") {
    listenOptions.exclusive = params.exclusive;
  }
  await new Promise<void>((resolve, reject) => {
    const tester = net
      .createServer()
      .once("error", (err) => reject(err))
      .once("listening", () => {
        // Binding succeeded; close immediately so the real server can claim the same port.
        tester.close(() => resolve());
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
    if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
      return "skip";
    }
    return "unknown";
  }
}

/** Checks all supported local address families without resolving listener diagnostics. */
export async function probePortUsage(port: number): Promise<PortUsageStatus> {
  let sawUnknown = false;
  for (const host of PORT_PROBE_HOSTS) {
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
