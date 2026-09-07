// Runs only in the trusted bridge container on the candidate-only internal network.
import http from "node:http";
const socketPath = process.argv[2];
if (socketPath !== "/bridge.sock") {
  throw new Error("Expected the controller-owned socket mount");
}
const server = http.createServer((incoming, outgoing) => {
  const request = http.request(
    {
      socketPath,
      path: incoming.url,
      method: incoming.method,
      headers: {
        "content-type": incoming.headers["content-type"] ?? "application/json",
        ...(incoming.headers.authorization
          ? { authorization: incoming.headers.authorization }
          : {}),
      },
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, {
        "content-type": response.headers["content-type"] ?? "application/json",
      });
      response.pipe(outgoing);
    },
  );
  request.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502);
    }
    outgoing.end();
  });
  incoming.on("aborted", () => request.destroy());
  outgoing.on("close", () => request.destroy());
  incoming.pipe(request);
});
server.requestTimeout = 45_000;
server.headersTimeout = 10_000;
server.listen(8080, "0.0.0.0");
