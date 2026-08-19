// Qa Lab plugin module reserves Gateway ports across pre-spawn setup.
import net from "node:net";

export async function reserveQaGatewayPort() {
  // This reserves a bind address; it must not impersonate a usable Gateway or
  // retain probes that would prevent release immediately before the real bind.
  const server = net.createServer((socket) => socket.destroy());
  const port = await new Promise<number>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.close(() => {});
      reject(error);
    };
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve gateway port"));
        return;
      }
      resolve(address.port);
    });
  });
  let releasePromise: Promise<void> | undefined;
  return {
    port,
    release() {
      releasePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return releasePromise;
    },
  };
}
