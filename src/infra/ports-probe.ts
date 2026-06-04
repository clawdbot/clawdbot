// Probes local ports and reports listener availability.
import net from "node:net";

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
