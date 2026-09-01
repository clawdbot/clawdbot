import { createServer, type RequestListener, type Server } from "node:http";

export function listenBrowserHttpServer(
  app: RequestListener,
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    // Install both terminal listeners before listen so Express cannot settle
    // its callback with a bind error before this startup Promise rejects.
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
