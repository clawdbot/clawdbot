import { pathToFileURL } from "node:url";
import { MessageChannel, Worker, type MessagePort, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { releaseOpenClawAgentDatabaseLease } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type {
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const options = { agentId: "main" };
const scope = { ...options, sessionId: "lease-failure", sessionKey: "agent:main:lease-failure" };

it.each([
  "startup",
  "claim-before",
  "claim-after",
  "release-exit",
  "release-error",
  "release-delete",
  "planner-ack",
] as const)(
  "reports %s failure and joins every native worker",
  async (fault) => {
    const stateDir = tempDirs.make("openclaw-reconcile-lease-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const workers: Worker[] = [];
      const ports: MessagePort[] = [];
      const modes: SessionTranscriptReconcileWorkerInput["mode"][] = [];
      let leaseId: string | undefined;
      let triggerInstalled = false;
      try {
        await persistSessionTranscriptTurn(scope, {
          messages: [{ eventId: "seed", message: { role: "user", content: "lease fixture" } }],
          touchSessionEntry: false,
        });
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        const state = openOpenClawStateDatabase();
        const readLeases = () =>
          state.db.prepare("SELECT lease_id FROM agent_database_leases ORDER BY lease_id").all();
        const baseline = readLeases();
        let leasesAtNativeFault: ReturnType<typeof readLeases> | undefined;
        expect(baseline).toHaveLength(1);
        const createWorker = (filename: string | URL, workerOptions: WorkerOptions) => {
          const input = workerOptions.workerData as SessionTranscriptReconcileWorkerInput;
          modes.push(input.mode);
          if (input.mode === "disk") {
            leaseId = input.leaseId;
          }
          let worker: Worker;
          if (fault === "startup" && input.mode === "disk") {
            worker = new Worker(new URL("./missing-worker.js", pathToFileURL(`${stateDir}/`)));
          } else if (input.mode === "release" && fault === "release-exit") {
            worker = new Worker("process.exit(0)", { eval: true });
          } else if (input.mode === "release" && fault === "release-error") {
            worker = new Worker("throw new Error('cleanup worker fixture')", { eval: true });
          } else if (
            input.mode === "disk" &&
            (fault === "claim-before" || fault === "claim-after")
          ) {
            const channel = new MessageChannel();
            ports.push(channel.port1, channel.port2);
            worker = new Worker(
              `const {workerData}=require('node:worker_threads');
               const {DatabaseSync}=require('node:sqlite');
               const prepare=DatabaseSync.prototype.prepare, exec=DatabaseSync.prototype.exec;
               let leaseDatabase;
               const pause=()=>{
                 workerData.proofPort.postMessage('paused');
                 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
               };
               DatabaseSync.prototype.prepare=function(sql){
                 const statement=prepare.call(this,sql);
                 if(sql.startsWith('insert into "agent_database_leases"')) {
                   const run=statement.run.bind(statement), database=this;
                   statement.run=(...args)=>{
                     if(${JSON.stringify(fault)}==='claim-before') pause();
                     const result=run(...args); leaseDatabase=database; return result;
                   };
                 }
                 return statement;
               };
               DatabaseSync.prototype.exec=function(sql){
                 const result=exec.call(this,sql);
                 if(this===leaseDatabase && sql==='COMMIT' && ${JSON.stringify(fault)}==='claim-after') pause();
                 return result;
               };
               void import(${JSON.stringify(String(filename))});`,
              {
                ...workerOptions,
                workerData: { ...input, proofPort: channel.port2 },
                transferList: [channel.port2],
                eval: true,
              },
            );
            // Pause on either side of the real canonical INSERT/COMMIT, before any plan reply.
            channel.port1.once("message", () => {
              leasesAtNativeFault = readLeases();
              void worker.terminate();
            });
          } else if (input.mode === "disk" && fault === "planner-ack") {
            // Native exit after the canonical DELETE commits, immediately before its ACK.
            worker = new Worker(
              `const {parentPort}=require('node:worker_threads');
               const post=parentPort.postMessage.bind(parentPort);
               parentPort.postMessage=(message,...args)=>{
                 if(message.type==='lease-released') process.exit(0);
                 post(message,...args);
               };
               void import(${JSON.stringify(String(filename))});`,
              { ...workerOptions, eval: true },
            );
          } else {
            worker = new Worker(filename, workerOptions);
          }
          workers.push(worker);
          worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
            if (input.mode !== "disk" || message.type !== "plan-start") {
              return;
            }
            if (fault === "release-exit" || fault === "release-error") {
              void worker.terminate();
            } else if (fault === "release-delete") {
              expect(input.leaseId).toMatch(/^[a-f0-9-]+$/u);
              // A persistent trigger affects the already-open worker connection, unlike TEMP.
              state.db.exec(`CREATE TRIGGER reject_test_lease_release
                BEFORE DELETE ON agent_database_leases WHEN OLD.lease_id = '${input.leaseId}'
                BEGIN SELECT RAISE(FAIL, 'lease release fixture'); END;`);
              triggerInstalled = true;
            }
          });
          return worker;
        };
        const result = await reconcileSessionTranscriptIndexes({ ...options, createWorker }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("native failure was reported as success");
        }
        expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
        expect(modes).toEqual(fault === "release-delete" ? ["disk"] : ["disk", "release"]);
        if (fault === "claim-before") {
          expect(leasesAtNativeFault).toEqual(baseline);
        } else if (fault === "claim-after") {
          expect(leasesAtNativeFault).toHaveLength(baseline.length + 1);
          expect(leasesAtNativeFault).toContainEqual({ lease_id: leaseId });
        }
        if (fault === "release-delete" || fault === "release-exit" || fault === "release-error") {
          expect(result.error).toMatchObject({
            message: expect.stringContaining("cleanup incomplete"),
          });
          expect(readLeases()).toEqual(
            [...baseline, { lease_id: leaseId }].toSorted((a, b) =>
              String(a.lease_id).localeCompare(String(b.lease_id)),
            ),
          );
        } else {
          expect(String(result.error)).not.toContain("cleanup incomplete");
          expect(readLeases()).toEqual(baseline);
        }
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        for (const port of ports) {
          port.close();
        }
        if (triggerInstalled) {
          openOpenClawStateDatabase().db.exec("DROP TRIGGER reject_test_lease_release");
        }
        if (leaseId) {
          releaseOpenClawAgentDatabaseLease(leaseId);
        }
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
  20_000,
);
