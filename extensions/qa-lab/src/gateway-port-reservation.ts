// Qa Lab plugin module reserves Gateway ports across pre-spawn setup.
type QaGatewayPortServer = {
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  listen(port: number, host: string, listener: () => void): void;
  address(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): void;
};

export async function reserveQaGatewayPort(createServer: () => QaGatewayPortServer) {
  const server = createServer();
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
