import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";

const browserFixturePath = "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs";
const clickclackFixturePath = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const httpProbePath = "scripts/e2e/lib/openwebui/http-probe.mjs";

function runScript(scriptPath: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runScriptAsync(
  scriptPath: string,
  args: string[] = [],
  env: Record<string, string> = {},
  timeout = 3_000,
) {
  return new Promise<{ stderr: string; stdout: string; status: number | null }>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ stderr, stdout, status });
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("e2e helper numeric env limits", () => {
  it("rejects loose Browser CDP fixture ports", async () => {
    const result = await runScriptAsync(browserFixturePath, [], { FIXTURE_PORT: "18080http" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid FIXTURE_PORT: 18080http");
  });

  it("rejects loose release ClickClack fixture ports", () => {
    const result = runScript(clickclackFixturePath, [], {
      CLICKCLACK_FIXTURE_PORT: "44181tcp",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid CLICKCLACK_FIXTURE_PORT: 44181tcp");
  });

  it("rejects loose Open WebUI HTTP probe timeouts", () => {
    const result = runScript(httpProbePath, ["http://127.0.0.1:9"], {
      OPENCLAW_HTTP_PROBE_TIMEOUT_MS: "8000ms",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_HTTP_PROBE_TIMEOUT_MS: 8000ms");
  });

  it("keeps Open WebUI HTTP probe status checks working with strict timeouts", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204).end();
    });
    const url = await listen(server);
    try {
      const result = await runScriptAsync(httpProbePath, [url, "204"], {
        OPENCLAW_HTTP_PROBE_TIMEOUT_MS: "500",
      });

      expect(result.status).toBe(0);
    } finally {
      server.close();
    }
  });
});
