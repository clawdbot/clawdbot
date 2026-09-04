import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { GatewayClient, GatewayClientRequestError } from "../../../../src/gateway/client.js";
import { discoverGatewayBeacons } from "../../../../src/infra/bonjour-discovery.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { stopChildProcess } from "../../../helpers/stop-child-process.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

const ORIGINS = {
  locked: "https://locked.service-policy.example.test",
  counter: "https://counter.service-policy.example.test",
  exempt: "https://exempt.service-policy.example.test",
  defaults: "https://defaults.service-policy.example.test",
};
const LONG_POLICY_MS = 600_000;
type Evidence = { prefix: string; observation: string; bootId: string; pid: number };
type HttpAuthProbe = { status: number; retryAfterSeconds: number };

async function probeHttpAuth(
  gateway: QaGatewayChild,
  localAddress: string,
  valid: boolean,
): Promise<HttpAuthProbe> {
  return await new Promise((resolve, reject) => {
    const req = request(
      new URL("/v1/models", gateway.baseUrl),
      {
        localAddress,
        agent: false,
        headers: { authorization: `Bearer ${valid ? gateway.token : randomUUID()}` },
        signal: AbortSignal.timeout(20_000),
      },
      (res) => {
        res.on("error", reject);
        res.resume();
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            retryAfterSeconds: Number(res.headers["retry-after"] ?? 0),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

async function probeBrowserAuth(gateway: QaGatewayChild, origin: string) {
  const result = createDeferredCore<Error>();
  const client = new GatewayClient({
    url: gateway.wsUrl,
    env: gateway.runtimeEnv,
    origin,
    token: randomUUID(),
    deviceIdentity: null,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: ["operator.read"],
    onHelloOk: () => result.reject(new Error("Browser accepted invalid credentials")),
    onConnectError: (error) => {
      result.resolve(error);
    },
  });
  const timer = setTimeout(() => result.reject(new Error("Browser auth probe timed out")), 20_000);
  try {
    client.start();
    const error = await result.promise;
    assert(error instanceof GatewayClientRequestError, "Expected a public connect error response");
    return {
      code: readConnectErrorDetailCode(error.details),
      retryAfterMs: error.retryAfterMs ?? 0,
    };
  } finally {
    clearTimeout(timer);
    await client.stopAndWait();
  }
}

function observeBonjourRemovals(port: number) {
  const child = spawn("avahi-browse", ["-prk", "_openclaw-gw._tcp"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ownServices = new Set<string>();
  const events: Array<{ kind: "resolved" | "removed"; service: string }> = [];
  let pending = "";
  let failure: Error | undefined;
  let stderr = "";
  child.once("error", (error) => {
    failure = error;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const fields = line.split(";");
      const service = fields.slice(1, 6).join(";");
      if (fields[0] === "=" && Number(fields[8]) === port) {
        ownServices.add(service);
        events.push({ kind: "resolved", service });
      } else if (fields[0] === "-" && ownServices.has(service)) {
        events.push({ kind: "removed", service });
      }
    }
  });
  return {
    events,
    check: () => {
      assert.ifError(failure);
      assert.equal(child.exitCode, null, `Avahi observer exited: ${stderr}`);
      assert.equal(child.signalCode, null, "Avahi observer was interrupted");
    },
    stop: async () => {
      if (child.pid) {
        await stopChildProcess(child, 2_000);
      }
    },
  };
}

export async function proveHotReloadServicePolicy({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const observations: Array<Record<string, unknown>> = [];
  const hostname = `qa-reload-${randomUUID().slice(0, 8)}`;
  const cliPath = path.join(repoRoot, "dist/index.js");
  const tailnetDns = "qa-service-policy.example.test";
  let connection: HotReloadConnection | undefined;
  let observer: ReturnType<typeof observeBonjourRemovals> | undefined;
  await runQaGatewayFixture(
    async () => {
      const gateway = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [cliPath],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerBaseUrl: "http://127.0.0.1:1/v1",
        transportBaseUrl: "http://127.0.0.1:1",
        controlUiEnabled: true,
        enabledPluginIds: ["bonjour"],
        runtimeEnvPatch: {
          OPENCLAW_DISABLE_BONJOUR: "0",
          OPENCLAW_MDNS_HOSTNAME: hostname,
          OPENCLAW_CLI_PATH: cliPath,
          OPENCLAW_TAILNET_DNS: tailnetDns,
          OPENCLAW_SSH_PORT: "22222",
        },
        mutateConfig: (cfg) => ({
          ...cfg,
          discovery: { ...cfg.discovery, mdns: { mode: "off" } },
          gateway: {
            ...cfg.gateway,
            reload: { mode: "hybrid" },
            auth: {
              ...cfg.gateway?.auth,
              rateLimit: {
                maxAttempts: 4,
                windowMs: LONG_POLICY_MS,
                lockoutMs: LONG_POLICY_MS,
                exemptLoopback: false,
              },
            },
            http: { endpoints: { responses: { enabled: true } } },
            controlUi: { ...cfg.gateway?.controlUi, allowedOrigins: Object.values(ORIGINS) },
          },
        }),
      });
      connection = await connectHotReloadClient(gateway);
      const primary = connection;
      const pid = gateway.pid;
      const bootId = primary.bootId;
      assert(pid && bootId);
      const rpc = <T>(method: string, params: unknown = {}) =>
        primary.client.request<T>(method, params, { timeoutMs: 40_000 });
      const patch = async (change: unknown) => {
        const { hash } = await rpc<{ hash: string }>("config.get");
        const apply = () =>
          rpc<{ sentinel: { payload: { stats: { requiresRestart: boolean } } } }>("config.patch", {
            baseHash: hash,
            raw: JSON.stringify(change),
          });
        const result = await apply().catch(async (error: unknown) => {
          if (
            !(error instanceof GatewayClientRequestError) ||
            !error.retryable ||
            typeof error.retryAfterMs !== "number" ||
            !error.message.startsWith("rate limit exceeded for config.patch")
          ) {
            throw error;
          }
          await delay(error.retryAfterMs);
          return await apply();
        });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
      };
      const record = async (prefix: string, observation: string) => {
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(primary.hellos, 1);
        assert.equal(primary.closes, 0);
        const fresh = await connectHotReloadClient(gateway);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        evidence.push({ prefix, observation, bootId, pid });
        appendLog(`PASS ${prefix}: ${observation}; PID ${pid}, boot ${bootId}\n`);
      };
      const group = async (prefix: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ prefix, message });
          appendLog(`FAIL ${prefix}: ${message}\n`);
        }
      };
      await group("gateway.auth.rateLimit", async () => {
        // Successful auth clears a budget. The controller and every tested
        // failure history therefore use distinct actual source IPs/origins.
        const http = (suffix: number, valid = false) =>
          probeHttpAuth(gateway, `127.0.0.${suffix}`, valid);
        const browser = (origin: string) => probeBrowserAuth(gateway, origin);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          assert.equal((await http(2)).status, 401);
          assert.equal(
            (await browser(ORIGINS.locked)).code,
            ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          );
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          assert.equal((await http(3)).status, 401);
          assert.equal(
            (await browser(ORIGINS.counter)).code,
            ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          );
        }
        assert.equal((await http(4)).status, 401);
        assert.equal((await http(5)).status, 401);
        const earnedHttp = await http(2, true);
        const earnedBrowser = await browser(ORIGINS.locked);
        assert.equal(earnedHttp.status, 429);
        assert.equal(earnedBrowser.code, ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
        const earnedAt = Date.now();
        const preservedBans = async () => {
          const retainedHttp = await http(2, true);
          const retainedBrowser = await browser(ORIGINS.locked);
          const elapsed = Date.now() - earnedAt;
          assert.equal(retainedHttp.status, 429);
          assert.equal(retainedBrowser.code, ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
          assert(
            Math.abs(
              retainedHttp.retryAfterSeconds * 1_000 +
                elapsed -
                earnedHttp.retryAfterSeconds * 1_000,
            ) < 2_000,
          );
          assert(
            Math.abs(retainedBrowser.retryAfterMs + elapsed - earnedBrowser.retryAfterMs) < 2_000,
          );
          observations.push({
            phase: "retained-lockout",
            http: retainedHttp,
            browser: retainedBrowser,
          });
        };
        await patch({ gateway: { auth: { rateLimit: { maxAttempts: 2, lockoutMs: 5_000 } } } });
        const tightenedHttp = await http(3, true);
        const tightenedBrowser = await browser(ORIGINS.counter);
        assert.equal(tightenedHttp.status, 429);
        assert.equal(tightenedBrowser.code, ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
        assert(tightenedHttp.retryAfterSeconds > 0 && tightenedHttp.retryAfterSeconds <= 5);
        assert(tightenedBrowser.retryAfterMs > 0 && tightenedBrowser.retryAfterMs <= 5_000);
        await preservedBans();
        await patch({ gateway: { controlUi: { toolTitles: false } } });
        assert.equal((await http(4)).status, 401);
        assert.equal((await http(4, true)).status, 429, "Unrelated reload discarded a failure");
        await preservedBans();
        await record(
          "gateway.auth.rateLimit.maxAttempts/lockoutMs",
          "HTTP and browser limits tightened against retained failures; new bans used five seconds while earned bans kept their original deadlines across both policy and unrelated reloads",
        );

        await patch({ gateway: { auth: { rateLimit: { windowMs: 1 } } } });
        assert.equal((await http(5)).status, 401);
        assert.equal(
          (await http(5, true)).status,
          200,
          "Shorter window must age out un-locked failures",
        );
        await preservedBans();
        await waitForHotReloadFact("new shorter HTTP lockout expires", async () => {
          const reply = await http(3, true);
          assert([200, 429].includes(reply.status));
          return reply.status === 200 ? true : undefined;
        });
        await record(
          "gateway.auth.rateLimit.windowMs",
          "Shortening the window expired retained failures while earned bans remained intact; a newly earned shorter ban expired without restarting",
        );

        await patch({
          gateway: { auth: { rateLimit: { windowMs: LONG_POLICY_MS, exemptLoopback: true } } },
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assert.equal((await http(6)).status, 401, "Loopback exemption must prevent HTTP lockout");
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          assert.equal(
            (await browser(ORIGINS.exempt)).code,
            ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          );
        }
        assert.equal(
          (await browser(ORIGINS.exempt)).code,
          ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
        );
        await patch({ gateway: { auth: { rateLimit: { exemptLoopback: false } } } });
        assert.equal(
          (await http(6, true)).status,
          429,
          "Turning exemption off must retain failures",
        );
        await preservedBans();
        await record(
          "gateway.auth.rateLimit.exemptLoopback",
          "HTTP loopback exemption enabled and disabled live without clearing failures; browser-origin clients remained rate-limited while loopback was exempt",
        );

        await patch({ gateway: { auth: { rateLimit: null } } });
        const configured = await rpc<{ config: OpenClawConfig }>("config.get");
        assert.equal(configured.config.gateway?.auth?.rateLimit, undefined);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assert.equal((await http(7)).status, 401);
        }
        for (let attempt = 0; attempt < 10; attempt += 1) {
          assert.equal(
            (await browser(ORIGINS.defaults)).code,
            ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
          );
        }
        const defaultBan = await browser(ORIGINS.defaults);
        assert.equal(defaultBan.code, ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
        assert(defaultBan.retryAfterMs > 290_000 && defaultBan.retryAfterMs <= 300_000);
        assert.equal(
          (await browser(ORIGINS.locked)).code,
          ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
        );
        await record(
          "gateway.auth.rateLimit.defaults",
          "Deleting rateLimit restored ten browser attempts, the five-minute default lockout, and HTTP loopback exemption; a previously earned browser ban survived deletion",
        );
      });

      await group("discovery.mdns.mode", async () => {
        const port = Number(new URL(gateway.baseUrl).port);
        observer = observeBonjourRemovals(port);
        const activeObserver = observer;
        const discover = async () => {
          activeObserver.check();
          return (await discoverGatewayBeacons({ domains: ["local."], timeoutMs: 5_000 })).filter(
            (beacon) => beacon.port === port && beacon.lanHost === `${hostname}.local`,
          );
        };
        const advertised = async (mode: "minimal" | "full") => {
          const beacons = await waitForHotReloadFact(
            `actual ${mode} mDNS TXT records`,
            async () => {
              const found = await discover();
              return found.length > 0 &&
                found.every((beacon) =>
                  mode === "full"
                    ? beacon.sshPort === 22222 &&
                      beacon.cliPath === cliPath &&
                      beacon.tailnetDns === tailnetDns
                    : ["sshPort", "cliPath", "tailnetDns"].every(
                        (key) => !Object.hasOwn(beacon.txt ?? {}, key),
                      ),
                )
                ? found
                : undefined;
            },
          );
          for (const beacon of beacons) {
            assert.equal(beacon.gatewayPort, port);
            assert.equal(beacon.role, "gateway");
            assert.equal(beacon.transport, "gateway");
          }
          observations.push({ phase: `mdns-${mode}`, beacons });
        };
        assert.equal((await discover()).length, 0);
        for (const mode of ["minimal", "full", "minimal"] as const) {
          await patch({ discovery: { mdns: { mode } } });
          await advertised(mode);
        }
        await waitForHotReloadFact("persistent observer resolves the advertised service", () => {
          activeObserver.check();
          return activeObserver.events.some((event) => event.kind === "resolved")
            ? true
            : undefined;
        });
        const cursor = activeObserver.events.length;
        await patch({ discovery: { mdns: { mode: "off" } } });
        // Avahi's removal event observes goodbye/expiry, so an empty discovery
        // result cannot pass merely because the observer stopped working.
        await waitForHotReloadFact("mDNS service removal after disable", () => {
          activeObserver.check();
          return activeObserver.events.slice(cursor).some((event) => event.kind === "removed")
            ? true
            : undefined;
        });
        assert.equal((await discover()).length, 0);
        await patch({ discovery: { mdns: { mode: "minimal" } } });
        await advertised("minimal");
        observations.push({ phase: "mdns-removals", events: activeObserver.events });
        await record(
          "discovery.mdns.mode",
          "Real multicast discovery changed off→minimal→full→minimal→off→minimal, including full-only TXT fields and an observed service removal before successful re-advertisement",
        );
      });
    },
    () => connection?.client.stopAndWait(),
    () => observer?.stop(),
    () =>
      stopQaGatewayFixture(owner, {
        preserveToDir: path.join(outputDir, "service-policy-gateway"),
      }),
    async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "gateway-config-hot-reload-service-policy.json"),
        `${JSON.stringify({ evidence, failures, observations }, null, 2)}\n`,
      );
    },
  );
  return { evidence, failures };
}
