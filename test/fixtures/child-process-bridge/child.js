import http from "node:http";

const server = http.createServer((_, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");
  process.stdout.write(`${addr.port}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
