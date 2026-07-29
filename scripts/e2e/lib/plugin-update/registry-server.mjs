// Fixture npm registry server for plugin update E2E scenarios.
import fs from "node:fs";
import http from "node:http";
import { readTcpPortEnv } from "../env-limits.mjs";

const portFile = process.argv[2];
if (!portFile) {
  console.error("usage: registry-server.mjs <port-file>");
  process.exit(2);
}

function buildMetadata(req) {
  const host = req.headers.host ?? "127.0.0.1";
  return {
    name: "@example/lossless-claw",
    "dist-tags": { latest: "0.9.0" },
    versions: {
      "0.9.0": {
        name: "@example/lossless-claw",
        version: "0.9.0",
        dist: {
          integrity: "sha512-same",
          shasum: "same",
          tarball: `http://${host}/@example/lossless-claw/-/lossless-claw-0.9.0.tgz`,
        },
      },
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/@example%2flossless-claw" || req.url === "/@example%2Flossless-claw") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildMetadata(req)));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(`not found: ${req.url}`);
});

const requestedPort =
  process.env.OPENCLAW_PLUGIN_UPDATE_REGISTRY_PORT === undefined
    ? 0
    : readTcpPortEnv("OPENCLAW_PLUGIN_UPDATE_REGISTRY_PORT");

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("plugin update registry did not expose a TCP port");
  }
  fs.writeFileSync(portFile, `${address.port}\n`);
});
