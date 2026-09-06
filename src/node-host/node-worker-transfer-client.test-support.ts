import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

export async function listen(server: HttpServer | HttpsServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test transfer server did not bind");
  }
  return `ws://127.0.0.1:${address.port}`;
}
