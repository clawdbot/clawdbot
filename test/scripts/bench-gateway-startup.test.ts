import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { __testing } from "../../scripts/bench-gateway-startup.ts";

async function listenOnLoopback(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected loopback port");
  }
  return { port: address.port, server };
}

describe("gateway startup benchmark script", () => {
  it("prints help without running benchmark cases", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-gateway-startup.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw Gateway startup benchmark");
    expect(result.stdout).toContain("--case <id>");
    expect(result.stdout).toContain("--cpu-prof-dir <dir>");
    expect(result.stdout).toContain("default (gateway default)");
    expect(result.stdout).not.toContain("[gateway-startup-bench]");
    expect(result.stderr).toBe("");
  });

  it("classifies HTTP listen and gateway ready logs separately", () => {
    expect(
      __testing.classifyGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)"),
    ).toBe("http-listen");
    expect(__testing.classifyGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(
      "gateway-ready",
    );
    expect(__testing.classifyGatewayReadyLog("[gateway] ready")).toBe("gateway-ready");
    expect(__testing.classifyGatewayReadyLog("[gateway] starting HTTP server...")).toBeNull();
  });

  it("summarizes split ready log timings without the ambiguous readyLogMs field", () => {
    const result = __testing.summarizeCase({ config: {}, id: "demo", name: "demo" }, [
      {
        cpuCoreRatio: null,
        cpuMs: null,
        exitCode: null,
        firstOutputMs: 1,
        gatewayReadyLogLine: "[gateway] ready",
        gatewayReadyLogMs: 40,
        healthz: {
          firstErrorKind: "econnrefused",
          firstRecoveryMs: 20,
          ms: 20,
          status: 200,
          transitions: [],
        },
        httpListenLogLine: "[gateway] http server listening (0 plugins)",
        httpListenLogMs: 10,
        maxRssMb: null,
        outputTail: "",
        readyz: {
          firstErrorKind: "http-503",
          firstRecoveryMs: 30,
          ms: 30,
          status: 200,
          transitions: [],
        },
        signal: null,
        startupTrace: {},
      },
    ]);

    expect(result.summary.httpListenLogMs?.p50).toBe(10);
    expect(result.summary.gatewayReadyLogMs?.p50).toBe(40);
    expect("readyLogMs" in result.summary).toBe(false);
  });

  it("collects Count-suffixed startup trace metrics", () => {
    const startupTrace: Record<string, number> = {};

    __testing.collectStartupTrace(
      "[gateway] startup trace: sidecars.acp.runtime-ready ready=1 readyCount=1 backend=acpx",
      startupTrace,
    );

    expect(startupTrace["sidecars.acp.runtime-ready.ready"]).toBeUndefined();
    expect(startupTrace["sidecars.acp.runtime-ready.readyCount"]).toBe(1);
  });

  it("records probe state transitions, first error kind, and first recovery", async () => {
    let calls = 0;
    const { port, server } = await listenOnLoopback((_req, res) => {
      calls += 1;
      res.statusCode = calls === 1 ? 503 : 200;
      res.end("ok");
    });
    try {
      const startAt = performance.now();
      const result = await __testing.waitForProbe({
        deadlineAt: startAt + 1_000,
        path: "/readyz",
        port,
        startAt,
      });

      expect(result.status).toBe(200);
      expect(result.ms).toEqual(expect.any(Number));
      expect(result.firstErrorKind).toBe("http-503");
      expect(result.firstRecoveryMs).toEqual(expect.any(Number));
      expect(result.transitions.map((transition) => transition.status)).toEqual([503, 200]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("writes 50-plugin fixtures as a parent load path with explicit startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      const configPath = __testing.writeConfig(root, {
        config: {},
        id: "fiftyPlugins",
        name: "gateway, 50 manifest plugins",
        pluginActivationOnStartup: true,
        pluginCount: 2,
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        plugins?: { allow?: string[]; load?: { paths?: string[] } };
      };

      expect(config.plugins?.load?.paths).toEqual([path.join(root, "plugins")]);
      expect(config.plugins?.allow).toEqual(["bench-plugin-01", "bench-plugin-02"]);
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps startup-lazy plugin fixtures opted out of startup activation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-config-test-"));
    try {
      __testing.writeConfig(root, {
        config: {},
        id: "fiftyStartupLazyPlugins",
        name: "gateway, 50 startup-lazy manifest plugins",
        pluginActivationOnStartup: false,
        pluginCount: 1,
      });
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", "bench-plugin-01", "openclaw.plugin.json"),
          "utf8",
        ),
      ) as { activation?: { onStartup?: boolean } };
      expect(manifest.activation?.onStartup).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
