import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { runManagedCommand } from "../../../../scripts/lib/managed-child-process.mts";
import { decodePairingSetupCode } from "../../../../src/pairing/setup-code.js";
import { KeyedAsyncQueue } from "../../../../src/plugin-sdk/keyed-async-queue.js";
import { PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { createChildEnv } from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPairedNodeWorkerHost,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

type PreparedWorkspace = {
  preparationKey: string;
  cacheKey: string;
  workspaceDir: string;
  homeDir: string;
  sourceManifestRef: string;
};
type FixtureLease = {
  root: string;
  env: NodeJS.ProcessEnv;
  host?: PairedNodeWorkerHost;
  prepared?: PreparedWorkspace;
  destroyed: boolean;
  retired: boolean;
  controller: AbortController;
  allocations: number;
  provisions: number;
  enrollments: number;
  scripts: number;
  uploads: number;
};
type FixtureRequest = {
  leaseId: string;
  script: string;
  remotePath: string;
  base64: string;
  setupCode: string;
  deviceId?: string;
  prepared: PreparedWorkspace;
};

/** Synthetic allocation only; project preparation, enrollment, and node RPCs use real owners. */
export async function startPreparedPoolWireProvider(root: string) {
  const token = randomUUID();
  const leases = new Map<string, FixtureLease>();
  const pending = new Set<Promise<void>>();
  const controller = new AbortController();
  const queue = new KeyedAsyncQueue();
  let connection: { gateway: WireGateway; operator: GatewayClient } | undefined;
  const destroy = async (lease: FixtureLease) => {
    lease.retired = true;
    lease.controller.abort();
    if (!lease.destroyed) {
      await lease.host?.stop();
      lease.destroyed = true;
    }
  };
  const operate = async (action: string, body: FixtureRequest, lease?: FixtureLease) => {
    if (action === "/allocate") {
      if (!lease || lease.retired) {
        throw new Error("Fixture allocation was retired");
      }
      await Promise.all(
        [lease.env.HOME!, lease.env.TMPDIR!].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
      lease.controller.signal.throwIfAborted();
      lease.allocations = 1;
      lease.provisions += 1;
      return { commandTimeoutMs: PROOF_TIMEOUT_MS };
    }
    if (action === "/inspect") {
      return !lease || lease.destroyed
        ? { status: "destroyed" }
        : { status: "active", sharedHost: false };
    }
    if (action === "/destroy") {
      if (lease) {
        await destroy(lease);
      }
      return {};
    }
    if (!lease || lease.retired) {
      throw new Error("Fixture lease is not active");
    }
    if (action === "/script") {
      lease.scripts += 1;
      let stdout = "";
      let stderr = "";
      const code = await runManagedCommand({
        bin: "sh",
        args: ["-c", body.script],
        cwd: lease.root,
        env: lease.env,
        signal: lease.controller.signal,
        timeoutMs: PROOF_TIMEOUT_MS,
        requireProcessTreeExit: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        onReady: (child) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout = (stdout + chunk.toString()).slice(-262_144);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-262_144);
          });
        },
      });
      if (code !== 0) {
        throw new Error(`Project preparation exited ${code}: ${stderr}`);
      }
      return { stdout };
    }
    if (action === "/upload") {
      const parent = await fs.realpath(path.dirname(body.remotePath));
      if (!parent.startsWith(`${lease.env.HOME}${path.sep}.openclaw-worker${path.sep}`)) {
        throw new Error("Project upload escaped its lease HOME");
      }
      lease.controller.signal.throwIfAborted();
      await fs.writeFile(body.remotePath, Buffer.from(body.base64, "base64"), { flag: "wx" });
      lease.uploads += 1;
      return {};
    }
    if (action === "/enroll") {
      if (body.deviceId && lease.host?.identity.deviceId === body.deviceId) {
        return { deviceId: body.deviceId };
      }
      if (!connection || lease.host) {
        throw new Error("Fixture enrollment has no fresh node owner");
      }
      if (decodePairingSetupCode(body.setupCode).url !== connection.gateway.wsUrl) {
        throw new Error("Fixture setup belongs to another Gateway");
      }
      lease.prepared = body.prepared;
      const host = await createPairedNodeWorkerHost({
        ...connection,
        root: lease.root,
        label: "prepared-node",
        enrollment: { setupCode: body.setupCode, env: lease.env },
        onCreate: (created) => {
          lease.host = created;
        },
        capacity: 1,
        bundlePrewarm: true,
        bundleRetention: true,
      });
      if (lease.retired) {
        await host.stop();
        throw new Error("Fixture enrollment retired before publication");
      }
      lease.enrollments += 1;
      return { deviceId: host.identity.deviceId };
    }
    throw new Error("Unknown fixture operation");
  };
  const dispatch = (action: string, body: FixtureRequest) => {
    controller.signal.throwIfAborted();
    if (!/^qa-prepared:provision:v2:[a-f0-9]{64}$/u.test(body.leaseId)) {
      throw new Error("Unknown fixture allocation identity");
    }
    let lease = leases.get(body.leaseId);
    if (action === "/allocate" && !lease) {
      const leaseRoot = path.join(root, createHash("sha256").update(body.leaseId).digest("hex"));
      const home = path.join(leaseRoot, "home");
      lease = {
        root: leaseRoot,
        env: createChildEnv({
          home,
          tempDir: path.join(leaseRoot, "tmp"),
          extra: {
            OPENCLAW_HOME: home,
            OPENCLAW_STATE_DIR: path.join(leaseRoot, "node-state"),
            OPENCLAW_CONFIG_PATH: path.join(leaseRoot, "openclaw.json"),
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
        }),
        controller: new AbortController(),
        retired: false,
        destroyed: false,
        allocations: 0,
        provisions: 0,
        enrollments: 0,
        scripts: 0,
        uploads: 0,
      };
      // Reserve the operation before any filesystem await; duplicate calls share one owner.
      leases.set(body.leaseId, lease);
    }
    if (action === "/destroy" && lease) {
      lease.retired = true;
      lease.controller.abort();
    }
    return queue.enqueue(body.leaseId, async () => await operate(action, body, lease));
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    const task = (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 4 * 1024 * 1024) {
          throw new Error("Fixture request exceeds its bounded project payload");
        }
        chunks.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as FixtureRequest;
      const result = await dispatch(request.url ?? "", body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    })()
      .catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Prepared pool fixture did not bind");
  }
  return {
    leases,
    config: { endpoint: `http://127.0.0.1:${address.port}`, token },
    connect: (gateway: WireGateway, operator: GatewayClient) => {
      connection = { gateway, operator };
    },
    async stop() {
      controller.abort();
      for (const lease of leases.values()) {
        lease.retired = true;
        lease.controller.abort();
      }
      const close = closeWireServer(server);
      await Promise.allSettled(pending);
      const stopped = await Promise.allSettled([
        close,
        ...[...leases.entries()].map(([id, lease]) =>
          queue.enqueue(id, async () => await destroy(lease)),
        ),
      ]);
      const failures = stopped.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Dedicated fixture nodes did not stop");
      }
    },
  };
}
