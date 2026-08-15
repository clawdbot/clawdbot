// Minimal QA bus poll endpoint for package/restart channel lifecycle proof.
import fs from "node:fs";
import http from "node:http";

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const port = Number(readOption("--port", "43123"));
const readyFile = readOption("--ready-file", "");
const logFile = readOption("--log-file", "");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`invalid --port: ${String(port)}`);
}
if (!readyFile || !logFile) {
  throw new Error("--ready-file and --log-file are required");
}

function appendEvent(event) {
  fs.appendFileSync(logFile, `${JSON.stringify({ atMs: Date.now(), ...event })}\n`);
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/poll") {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      appendEvent({ accountId: input.accountId ?? null, path: "/v1/poll" });
      setTimeout(() => {
        if (!response.writableEnded) {
          writeJson(response, 200, {
            cursor: Number.isInteger(input.cursor) ? input.cursor : 0,
            events: [],
          });
        }
      }, 100);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(readyFile, `${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
