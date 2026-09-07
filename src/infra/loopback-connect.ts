import type { TcpNetConnectOpts } from "node:net";

export function createLoopbackConnectOptions(port: number): TcpNetConnectOpts {
  return {
    host: "localhost",
    port,
    autoSelectFamily: true,
    lookup(_hostname, options, callback) {
      // Localhost records can omit a family even when its loopback listener works.
      queueMicrotask(() => {
        if (options.all) {
          callback(null, [
            { address: "127.0.0.1", family: 4 },
            { address: "::1", family: 6 },
          ]);
        } else if (options.family === 6) {
          callback(null, "::1", 6);
        } else {
          callback(null, "127.0.0.1", 4);
        }
      });
    },
  };
}
