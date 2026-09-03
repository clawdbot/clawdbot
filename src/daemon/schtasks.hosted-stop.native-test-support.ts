// Native owner-boundary probe; transport is HTTP, not the Gateway WebSocket protocol.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import { runSystemAgentGatewayTask } from "../gateway/server-methods/system-agent-execution.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { getCommandLaneSnapshot, getTotalQueueSize } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../system-agent/audit.js";
import { executeSystemAgentOperation } from "../system-agent/operations-execute.js";

export async function runHostedStopNativeProbe(params: {
  port: number;
  activePidPath: string;
  childPidPath: string;
  appendEvent: (phase: string, details?: Record<string, unknown>) => void;
}): Promise<void> {
  const { appendEvent } = params;
  const snapshot = () => ({
    roots: getActiveGatewayRootWorkCount(),
    active: getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount,
    queued: getCommandLaneSnapshot(CommandLane.SystemAgent).queuedCount,
  });
  let requested = false;
  let responseFinished = false;
  let closed = false;
  await runGatewayLoop({
    ownsProcessLifecycle: true,
    lockPort: params.port,
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code) => {
        appendEvent("gateway-exit", { code });
        process.exit(code);
      },
    },
    completeBoot: (completion) => appendEvent("boot-completion", completion),
    start: async (options) => {
      const host = options?.hostLifecycle;
      // External stop/restart must still extinguish this idle descendant. Hosted
      // close owns its graceful IPC exit, as a real server owns worker teardown.
      const child = spawn(
        process.execPath,
        ["-e", "process.once('message', () => process.exit(0)); setInterval(() => {}, 1000)"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const childExit = once(child, "exit");
      fs.writeFileSync(params.childPidPath, String(child.pid));
      const server = createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/approved-stop" || requested) {
          response.writeHead(404).end();
          return;
        }
        requested = true;
        void runWithGatewayIndependentRootWorkAdmission(async () => {
          let callerLive = true;
          try {
            const lines: string[] = [];
            await runSystemAgentGatewayTask(async () => {
              const result = await executeSystemAgentOperation(
                { kind: "gateway-stop" },
                {
                  log: (...args) => lines.push(args.join(" ")),
                  error: () => {
                    throw new Error("Native hosted-stop audit failed");
                  },
                  exit: () => {
                    throw new Error("SystemAgent attempted process exit");
                  },
                },
                {
                  approved: true,
                  beforePersistentApply: () => {
                    assert(callerLive && !closed);
                    assert.deepEqual(snapshot(), { roots: 1, active: 1, queued: 0 });
                    appendEvent("caller-live", snapshot());
                  },
                  deps: { setupSurface: "gateway", gatewayHostLifecycle: host },
                },
              );
              assert.equal(result.applied, true);
              assert(lines.includes("Scheduled Gateway stop"));
              assert(lines.includes("[openclaw] done: gateway.stop"));
              const audits = createSqliteAuditRecordStore<SystemAgentAuditEntry>({
                scope: SYSTEM_AGENT_AUDIT_SCOPE,
                maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
              }).entries();
              assert.equal(audits.length, 1);
              assert.equal(audits[0]?.value.summary, "Scheduled Gateway stop");
              assert.equal(closed, false);
              assert.deepEqual(snapshot(), { roots: 1, active: 1, queued: 0 });
              appendEvent("operation-settled", { ...snapshot(), audit: "Scheduled Gateway stop" });
            });
            assert.deepEqual(snapshot(), { roots: 1, active: 0, queued: 0 });
            await new Promise<void>((resolve, reject) => {
              response.once("error", reject);
              response.end(JSON.stringify({ outcome: "scheduled", nativeCompleted: false }), () => {
                responseFinished = true;
                appendEvent("response-finished", snapshot());
                resolve();
              });
            });
          } finally {
            callerLive = false;
          }
        }, "native-hosted-stop").catch((error: unknown) => {
          const detail = error instanceof Error ? error.message.slice(0, 500) : "Non-error failure";
          appendEvent("request-failed", { detail });
          response.destroy();
          process.exit(1);
        });
      });
      server.listen({ host: "127.0.0.1", port: params.port, exclusive: true });
      await once(server, "listening");
      const temporaryPidPath = `${params.activePidPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPidPath, String(process.pid));
      fs.renameSync(temporaryPidPath, params.activePidPath);
      appendEvent("listening");
      return {
        startupSettled: Promise.resolve(),
        getTailscaleIngressEndpoint: () => undefined,
        close: async () => {
          assert.equal(responseFinished, true);
          assert.deepEqual(snapshot(), { roots: 0, active: 0, queued: 0 });
          assert.equal(getTotalQueueSize(), 0);
          closed = true;
          appendEvent("close", snapshot());
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          child.send("stop");
          const [code, signal] = await childExit;
          assert.equal(code, 0);
          assert.equal(signal, null);
          appendEvent("descendant-exit", { code });
        },
      };
    },
  });
}
