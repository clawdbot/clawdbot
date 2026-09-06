import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSystemBin } from "../../infra/resolve-system-bin.js";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

function resolveOpenSsl3(): string | null {
  const candidates = [
    resolveSystemBin("openssl"),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"]
      : []),
  ];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) {
      continue;
    }
    try {
      if (execFileSync(candidate, ["version"], { encoding: "utf8" }).startsWith("OpenSSL 3.")) {
        return candidate;
      }
    } catch {
      // Try the next trusted fixed-path candidate.
    }
  }
  return null;
}

const openssl = resolveOpenSsl3();
let origin: Server | undefined;
let proxy: SecretEgressProxyHandle | undefined;
const tempDirs = createTrackedTempDirs();

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test origin did not bind a TCP port");
  }
  return address.port;
}

async function runStrictProxyRequest(params: {
  caPath: string;
  originPort: number;
  proxyUrl: URL;
}): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(
    openssl!,
    [
      "s_client",
      "-proxy",
      `${params.proxyUrl.hostname}:${params.proxyUrl.port}`,
      "-proxy_user",
      params.proxyUrl.username,
      "-proxy_pass",
      "env:OPENCLAW_TEST_PROXY_PASSWORD",
      "-connect",
      `localhost:${params.originPort}`,
      "-servername",
      "localhost",
      "-CAfile",
      params.caPath,
      "-verify_return_error",
      "-x509_strict",
      "-quiet",
    ],
    {
      env: { ...process.env, OPENCLAW_TEST_PROXY_PASSWORD: params.proxyUrl.password },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(
    `GET /strict-proof HTTP/1.1\r\nHost: localhost:${params.originPort}\r\nConnection: close\r\n\r\n`,
  );
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stderr, stdout };
}

afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  if (origin) {
    origin.closeAllConnections?.();
    await new Promise<void>((resolve) => origin?.close(() => resolve()));
    origin = undefined;
  }
  await tempDirs.cleanup();
});

describe.runIf(openssl)("secret egress proxy OpenSSL compatibility", () => {
  it("serves an HTTPS request to a strict OpenSSL client", async () => {
    const tempDir = await tempDirs.make("openclaw-egress-openssl-");
    proxy = await startSecretEgressProxyServer({
      caDir: tempDir,
      allowedHosts: ["localhost"],
      onAudit: () => {},
    });
    const originLeaf = await generateLocalProxyLeaf({
      certDir: tempDir,
      ca: { certPath: proxy.caCertPath, keyPath: path.join(tempDir, "root-ca-key.pem") },
      hostname: "localhost",
    });
    origin = createHttpsServer(originLeaf, (_request, response) => {
      response.writeHead(200, { Connection: "close", "Content-Length": 15 });
      response.end("strict-proxy-ok");
    });
    const originPort = await listen(origin);
    const env = proxy.registerRun({ instanceId: "instance-1", runId: "run-1" });
    const proxyUrl = new URL(env.HTTPS_PROXY!);

    const result = await runStrictProxyRequest({
      caPath: proxy.caCertPath,
      originPort,
      proxyUrl,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("HTTP/1.1 200 OK");
    expect(result.stdout).toContain("strict-proxy-ok");
  });
});
