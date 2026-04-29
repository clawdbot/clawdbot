import http from "node:http";

const metadata = {
  name: "@example/lossless-claw",
  "dist-tags": { latest: "0.9.0" },
  versions: {
    "0.9.0": {
      name: "@example/lossless-claw",
      version: "0.9.0",
      dist: {
        integrity: "sha512-same",
        shasum: "same",
        tarball: "http://127.0.0.1:4873/@example/lossless-claw/-/lossless-claw-0.9.0.tgz",
      },
    },
  },
};

const server = http.createServer((req, res) => {
  if (req.url === "/@example%2flossless-claw" || req.url === "/@example%2Flossless-claw") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(metadata));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(`not found: ${req.url}`);
});

server.listen(4873, "127.0.0.1");
