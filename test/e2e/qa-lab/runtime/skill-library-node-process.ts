// The existing paired-node helper is token-only. This lane runs the foreground node CLI
// against the trusted-proxy Gateway's supported direct-local password boundary instead.
import fs from "node:fs/promises";
import path from "node:path";
import { runManagedCommand } from "../../../../scripts/lib/managed-child-process.mts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { waitFor } from "./cloud-worker-midturn-loss-fixture.js";
import type { SkillLibraryWireClient } from "./skill-library-wire-fixture.js";

type Pairing = { requestId: string; deviceId: string; displayName?: string; role?: string };
type ListedNode = {
  nodeId: string;
  displayName?: string;
  approvalState?: string;
  connected?: boolean;
  paired?: boolean;
  sessionHost?: boolean;
};

export async function startSkillLibraryNodeProcess(
  gateway: OpenClawTestInstance,
  admin: SkillLibraryWireClient,
) {
  const node = await createOpenClawTestInstance({
    name: "skill-library-node",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: gateway.gatewayToken,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      NODE_ENV: undefined,
      CODEX_HOME: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    },
  });
  const abort = new AbortController();
  let failure: Error | undefined;
  let logs = "";
  let completion: Promise<void> | undefined;
  const stop = async () => {
    abort.abort();
    await completion;
    // Failed process-tree cleanup must retain state for diagnosis.
    if (failure) {
      throw failure;
    }
    await node.cleanup();
  };
  try {
    // Worker state uses os.tmpdir(); own that root so location assertions cannot accept host-global state.
    const workerTmpDir = path.join(node.stateDir, "tmp");
    await fs.mkdir(workerTmpDir, { recursive: true, mode: 0o700 });
    await node.state.writeConfig({ nodeHost: { workerRuns: { enabled: true } } });
    const entrypoint = await node.entrypoint();
    completion = runManagedCommand({
      bin: process.execPath,
      args: [
        ...entrypoint,
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(gateway.port),
        "--display-name",
        "Skill library proof node",
        "--ephemeral",
      ],
      cwd: process.cwd(),
      env: { ...node.env, TMPDIR: workerTmpDir, TMP: workerTmpDir, TEMP: workerTmpDir },
      stdio: ["ignore", "pipe", "pipe"],
      signal: abort.signal,
      requireProcessTreeExit: process.platform !== "win32",
      onReady: (child) => {
        const append = (data: Buffer) => {
          logs = (logs + data.toString()).slice(-8_000);
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
      },
    }).then(
      (code) => {
        failure = new Error(`Proof node exited unexpectedly (${code})`);
      },
      (error: unknown) => {
        if (!(abort.signal.aborted && (error as { code?: string }).code === "ABORT_ERR")) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      },
    );
    const readNodes = async () => {
      if (failure) {
        throw new Error(`Proof node stopped before readiness\n${logs}`, { cause: failure });
      }
      return (await admin.request<{ nodes: ListedNode[] }>("node.list", {})).nodes;
    };
    const admission = await waitFor("proof node device admission", async () => {
      const nodes = await readNodes();
      const listed = nodes.find((entry) => entry.displayName === "Skill library proof node");
      if (listed) {
        return { nodeId: listed.nodeId };
      }
      const devices = await admin.request<{ pending: Pairing[] }>("device.pair.list", {});
      const pending = devices.pending.find(
        (entry) => entry.displayName === "Skill library proof node" && entry.role === "node",
      );
      return pending ? { nodeId: pending.deviceId, requestId: pending.requestId } : undefined;
    });
    if ("requestId" in admission) {
      await admin.request("device.pair.approve", { requestId: admission.requestId });
    }
    const approval = await waitFor("proof node command approval", async () => {
      const listed = (await readNodes()).find((entry) => entry.nodeId === admission.nodeId);
      if (listed?.approvalState === "approved") {
        return { approved: true as const };
      }
      const pending = await admin.request<{
        pending: Array<{ requestId: string; nodeId: string }>;
      }>("node.pair.list", {});
      const request = pending.pending.find((entry) => entry.nodeId === admission.nodeId);
      return request ? { approved: false as const, requestId: request.requestId } : undefined;
    });
    if (!approval.approved) {
      await admin.request("node.pair.approve", { requestId: approval.requestId });
    }
    await waitFor("proof node worker inventory", async () => {
      const listed = (await readNodes()).find((entry) => entry.nodeId === admission.nodeId);
      return listed?.approvalState === "approved" &&
        listed.connected &&
        listed.paired &&
        listed.sessionHost
        ? listed
        : undefined;
    });
    return { nodeId: admission.nodeId, stateDir: node.stateDir, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Proof node startup and cleanup failed");
    }
    throw error;
  }
}
