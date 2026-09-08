import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { createTriageBoundary } from "./update-managed-service-triage.test-support.js";

const boundaries: Awaited<ReturnType<typeof createTriageBoundary>>[] = [];
afterEach(async () => {
  for (const boundary of boundaries.splice(0)) {
    await boundary.cleanup();
  }
});
const itUnix = process.platform === "win32" ? it.skip : it;

async function start(...args: Parameters<typeof createTriageBoundary>) {
  const boundary = await createTriageBoundary(...args);
  boundaries.push(boundary);
  return boundary;
}
async function ready(boundary: Awaited<ReturnType<typeof start>>) {
  expect(await boundary.response(), boundary.stderr()).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
}
async function fixing(boundary: Awaited<ReturnType<typeof start>>) {
  // One readiness budget covers the fixer and its complete descendant placement.
  await vi.waitFor(
    async () => {
      const events = await boundary.readEvents();
      expect(
        events.filter((event) => event.kind === "branch"),
        `${await boundary.log().catch(() => boundary.stderr())}\nEvents: ${events.map((event) => event.kind).join(", ")}`,
      ).toHaveLength(1);
      expect(
        (await boundary.members()).filter((member) => member.alive).length,
      ).toBeGreaterThanOrEqual(4);
    },
    { timeout: 15_000 },
  );
}
async function closed(boundary: Awaited<ReturnType<typeof start>>) {
  await vi.waitFor(
    async () => {
      expect((await boundary.readEvents()).some((event) => event.kind === "scope-stopped")).toBe(
        true,
      );
      expect((await boundary.members()).filter((member) => member.alive)).toEqual([]);
    },
    { timeout: 5000 },
  );
  const events = await boundary.readEvents();
  const attached = events.findIndex((event) => event.kind === "attached");
  const afterAttachment = events.slice(Math.max(0, attached));
  expect(afterAttachment.filter((event) => event.kind === "start")).toEqual([]);
  expect(events.filter((event) => event.kind === "fixer")).toHaveLength(1);
}

describe("managed triage attachment cutover (synthetic native boundary)", () => {
  itUnix.each(["allowed", "before-grant", "after-admission"] as const)(
    "retains the chat requester's authority at the repair effect boundary: %s",
    async (window) => {
      const boundary = await start("update", undefined, undefined, async (root, env) => {
        const configPath = env.OPENCLAW_CONFIG_PATH!;
        await fs.writeFile(
          configPath,
          JSON.stringify({
            plugins: { enabled: false },
            commands: { ownerAllowFrom: ["owner"] },
          }),
        );
        const daemon = path.join(root, "dist/cli/daemon-cli.js");
        await fs.mkdir(path.dirname(daemon), { recursive: true });
        const authority = resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.requester).href;
        await fs.writeFile(
          daemon,
          `
export { createManagedUpdateRequesterAuthority } from ${JSON.stringify(authority)};
import { createManagedUpdateRequesterAuthority } from ${JSON.stringify(authority)};
export async function isManagedUpdateRequesterOwner(requester) {
  return (await createManagedUpdateRequesterAuthority(requester)).isCurrent();
}
`,
        );
        await fs.writeFile(path.join(root, "package.json"), '{"type":"module","name":"openclaw"}');
        const paramsPath = path.join(root, "handoff.json");
        const params = JSON.parse(await fs.readFile(paramsPath, "utf8"));
        params.requester = { channel: "synthetic", senderId: "owner" };
        params.recoveryModulePath = daemon;
        await fs.writeFile(paramsPath, JSON.stringify(params));
        const continuation = resolveRuntimeWorkerUrl(
          triageTestRuntimeEntrypoints.continuation,
        ).href;
        await fs.writeFile(
          path.join(root, "candidate.mjs"),
          `
import fs from 'node:fs';
import { acceptTriageContinuation } from ${JSON.stringify(continuation)};
const event = kind => fs.appendFileSync(${JSON.stringify(path.join(root, "events.jsonl"))}, JSON.stringify({kind,pid:process.pid})+'\\n');
const revoke = () => {
  fs.writeFileSync(${JSON.stringify(configPath)}, JSON.stringify({plugins:{enabled:false},commands:{ownerAllowFrom:['replacement']}}));
  event('requester-revoked');
};
if (${JSON.stringify(window)} === 'before-grant') {
  const send = process.send.bind(process);
  process.send = (message,...args) => { if(message.type === 'triage-ready') revoke(); return send(message,...args); };
}
const admission = await acceptTriageContinuation();
const helperPid = process.ppid;
event('admitted');
if (${JSON.stringify(window)} === 'after-admission') {
  admission.signal.addEventListener('abort', () => {
    event('requester-refused');
    process.kill(helperPid, 'SIGCONT');
  }, {once:true});
  // Suspend the synthetic helper so its watchdog cannot protect this effect.
  process.kill(helperPid, 'SIGSTOP');
  revoke();
}
try {
  admission.assertCurrent();
  event('repair-effect');
} finally {
  if (${JSON.stringify(window)} === 'after-admission') process.kill(helperPid, 'SIGCONT');
}
await admission.finish('closed');
`,
        );
      });
      await ready(boundary);
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      await boundary.exit;
      const events = await boundary.readEvents();
      expect(events.filter((event) => event.kind === "repair-effect")).toHaveLength(
        window === "allowed" ? 1 : 0,
      );
      expect(events.filter((event) => event.kind === "requester-revoked")).toHaveLength(
        window === "allowed" ? 0 : 1,
      );
      expect(events.filter((event) => event.kind === "admitted")).toHaveLength(
        window === "before-grant" ? 0 : 1,
      );
      if (window === "after-admission") {
        expect(events.filter((event) => event.kind === "requester-refused")).toHaveLength(1);
      }
      if (window !== "allowed") {
        expect(await boundary.log()).toMatch(/requester-revoked|cancelled by termination signal/);
      }
    },
  );

  itUnix.each(["metadata", "ack", "disconnect", "refused"] as const)(
    "does not start a staged repair after admission fails during %s",
    async (window) => {
      const boundary = await start("update", undefined, undefined, async (root) => {
        const updater = path.join(root, "updater.cjs");
        let source = await fs.readFile(updater, "utf8");
        const interrupt =
          window === "metadata"
            ? `const fsp=require('node:fs/promises'), read=fsp.readFile;
fsp.readFile=async function(...args) {
  const result=await read.apply(this,args);
  if(args[0]===process.env.OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META) {
    event('admission-interrupted'); controller.abort(new Error('fixture cancellation'));
  }
  return result;
};`
            : `process.prependListener('message',message=>{
  if(message.type!=='triage-queued') return;
  event('admission-interrupted');
  ${window === "ack" ? "controller.abort(new Error('fixture cancellation'));" : window === "disconnect" ? "process.disconnect();" : "message.type='triage-refused';"}
});`;
        source = source.replace(
          "event('updater');",
          `event('updater'); const controller=new AbortController();\n${interrupt}`,
        );
        source = source.replace("'triage']))", "'triage'],controller.signal))");
        source = source.replaceAll(
          "process.disconnect();process.exitCode",
          "if(process.connected)process.disconnect();process.exitCode",
        );
        await fs.writeFile(updater, source);
      });
      await ready(boundary);
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      expect(await boundary.exit, await boundary.log()).toEqual({ code: 9, signal: null });
      const events = await boundary.readEvents();
      expect(events.filter((event) => event.kind === "admission-interrupted")).toHaveLength(1);
      expect(
        events.filter((event) => ["fixer", "attached", "triage-queued"].includes(event.kind)),
      ).toEqual([]);
      expect(boundary.readLease()).toBeUndefined();
      expect(await boundary.log()).toContain("exited code=9 signal=null");
    },
  );

  itUnix.each(["received", "lost"] as const)(
    "keeps one helper-owned repair when the commit acknowledgment is %s",
    async (acknowledgment) => {
      const boundary = await start("update", undefined, undefined, async (root) => {
        const updater = path.join(root, "updater.cjs");
        let source = await fs.readFile(updater, "utf8");
        source = source.replace(
          "event('updater');",
          `event('updater');
let accepted=false;
const emit=process.emit,send=process.send.bind(process);
process.send=function(message,...args){
  if(message.type==='triage-commit')event('commit-dispatched');
  return send(message,...args);
};
process.emit=function(kind,message,...args){
  if(kind==='message' && message?.type==='triage-committed'){
    event('commit-accepted');accepted=true;
    ${acknowledgment === "lost" ? "process.disconnect();return false;" : ""}
  }
  return emit.call(this,kind,message,...args);
};`,
        );
        source = source.replace("event('triage-queued');", "event('triage-queued',{accepted});");
        source = source.replace(
          "console.error(error);",
          "event('queue-rejected',{error:String(error)});console.error(error);",
        );
        source = source.replaceAll(
          "process.disconnect();process.exitCode",
          "if(process.connected)process.disconnect();process.exitCode",
        );
        await fs.writeFile(updater, source);
      });
      await ready(boundary);
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      await fixing(boundary);
      const events = await boundary.readEvents();
      expect(events.filter((event) => event.kind === "updater")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "commit-dispatched")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "commit-accepted")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "fixer")).toHaveLength(1);
      if (acknowledgment === "received") {
        expect(events.find((event) => event.kind === "triage-queued")).toMatchObject({
          accepted: true,
        });
        expect(events.filter((event) => event.kind === "queue-rejected")).toEqual([]);
      } else {
        expect(events.filter((event) => event.kind === "triage-queued")).toEqual([]);
        expect(events.find((event) => event.kind === "queue-rejected")?.error).toContain(
          "handoff confirmation lost",
        );
      }
      expect(await boundary.log()).toContain(
        `exited code=${acknowledgment === "received" ? 7 : 9} signal=null`,
      );
      expect(JSON.parse(String(boundary.readLease()!.payload_json)).action.phase).toBe("running");
      await boundary.native("stop");
      await closed(boundary);
    },
  );

  itUnix("releases a partial native fixture when setup rejects", async () => {
    const failure = new Error("fixture setup rejected");
    let root: string | undefined;
    let parent: { parentPid: number; parentStartIdentity: string } | undefined;
    try {
      await expect(
        createTriageBoundary("startup", undefined, undefined, async (fixtureRoot) => {
          root = fixtureRoot;
          parent = JSON.parse(await fs.readFile(path.join(root, "handoff.json"), "utf8"));
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(parent).toBeDefined();
      expect(isPidAlive(parent!.parentPid)).toBe(false);
      await expect(fs.access(root!)).rejects.toThrow();
    } finally {
      // The pre-fix regression deliberately leaves this exact synthetic parent alive.
      if (
        parent &&
        isPidAlive(parent.parentPid) &&
        String(getFileLockProcessStartTime(parent.parentPid)) === parent.parentStartIdentity
      ) {
        process.kill(parent.parentPid, "SIGKILL");
        await vi.waitFor(() => expect(isPidAlive(parent!.parentPid)).toBe(false));
      }
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  itUnix.each(["startup", "update"] as const)(
    "retires updater role only in the admitted %s fixer and its descendants",
    async (mode) => {
      const boundary = await start(mode);
      await ready(boundary);
      if (mode === "update") {
        expect(await boundary.control("park")).toBe("parked");
      }
      expect(await boundary.control("commit")).toBe("committed");
      if (mode === "update") {
        boundary.parent.kill();
      }
      await fixing(boundary);
      const events = await boundary.readEvents();
      expect(events.find((event) => event.kind === "fixer")).toMatchObject({
        handoff: null,
        sentinel: null,
      });
      expect(events.find((event) => event.kind === "descendant")).toMatchObject({
        handoff: null,
        sentinel: null,
        stateDir: `${boundary.root}/.openclaw`,
        workspace: `${boundary.root}/.openclaw/workspace`,
        shell: "exec",
        compileCache: "1",
      });
      expect(events.find((event) => event.kind === "show")).toMatchObject({
        handoff: null,
        sentinel: null,
      });
      if (mode === "update") {
        expect(events.find((event) => event.kind === "updater")).toMatchObject({
          handoff: "1",
          sentinel: `${boundary.root}/meta.json`,
        });
        const sentinel = boundary.readSentinel();
        expect(sentinel).toBeDefined();
        await boundary.native("stop");
        await closed(boundary);
        expect(boundary.readSentinel()).toEqual(sentinel);
      }
    },
  );

  itUnix.each(["active", "inactive"] as const)(
    "keeps the fixer alive during %s primary maintenance",
    async (primary) => {
      const boundary = await start("startup", undefined, primary);
      await ready(boundary);
      expect(await boundary.control("commit")).toBe("committed");
      await fixing(boundary);
      const events = await boundary.readEvents();
      expect(events.filter((event) => event.kind === "stop")).toEqual([]);
      expect(
        events.find((event) => event.kind === "maintenance-result"),
        JSON.stringify(events),
      ).toMatchObject({
        result: { stopped: false, inspected: true, running: primary === "active", kind: "owned" },
      });
      if (primary === "active") {
        expect(events.find((event) => event.kind === "maintenance-refused")?.error).toContain(
          "automatic triage",
        );
        expect(events.find((event) => event.kind === "maintenance-refused")?.error).toContain(
          "outside",
        );
      } else {
        expect(events.find((event) => event.kind === "doctor-maintenance")).toMatchObject({
          admitted: true,
        });
        expect(events.find((event) => event.kind === "maintenance-refused")).toBeUndefined();
      }
      await boundary.native("stop");
      await closed(boundary);
    },
  );

  itUnix(
    "admits once without parking, survives an intended restart and cancels after parent exit",
    async () => {
      const boundary = await start();
      await ready(boundary);
      expect((await boundary.readEvents()).filter((event) => event.kind === "stop")).toEqual([]);
      expect(await boundary.control("commit")).toBe("committed");
      await fixing(boundary);
      await boundary.native("restart");
      expect(boundary.helper.exitCode).toBeNull();
      expect((await boundary.readEvents()).filter((event) => event.kind === "fixer")).toHaveLength(
        1,
      );
      const parentExit = new Promise((resolve) => {
        boundary.parent.once("exit", resolve);
      });
      boundary.parent.kill();
      await parentExit;
      await boundary.native("stop");
      await closed(boundary);
      expect(await boundary.replay()).toContain("HANDOFF_BUSY");
      expect((await boundary.readEvents()).filter((event) => event.kind === "fixer")).toHaveLength(
        1,
      );
    },
  );

  itUnix("admits unsafe update triage with preserved activation and deferred health", async () => {
    const boundary = await start("update");
    await ready(boundary);
    expect(await boundary.control("park")).toBe("parked");
    expect(await boundary.control("commit")).toBe("committed");
    boundary.parent.kill();
    await fixing(boundary);
    const events = await boundary.readEvents();
    const kinds = events.map((event) => event.kind);
    expect(events.find((event) => event.kind === "fixer")?.failure?.gateway).toBe("preserve");
    expect(await boundary.log()).toContain('{"status":"error","reason":"original failure"}');
    expect(await boundary.log()).toContain("exited code=7 signal=null");
    expect(kinds.filter((kind) => kind === "updater")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "triage-queued")).toHaveLength(1);
    expect(
      kinds.filter((kind) => kind === "start" || kind === "restart" || kind === "restore-failed"),
    ).toEqual([]);
    expect(kinds.indexOf("attached")).toBeLessThan(kinds.indexOf("fixer"));
    await boundary.native("stop");
    await closed(boundary);
  });

  itUnix("retargets the completed update owner after package-to-Git exposure", async () => {
    const boundary = await start("update", undefined, undefined, undefined, true);
    await ready(boundary);
    const before = boundary.readLease()!;
    const helper = JSON.parse(String(before.payload_json)).helper;
    expect(await boundary.control("park")).toBe("parked");
    expect(await boundary.control("commit")).toBe("committed");
    boundary.parent.kill();
    await vi.waitFor(
      async () => {
        expect(
          (await boundary.readEvents()).filter((event) => event.kind === "triage-queued"),
        ).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    await fixing(boundary);
    const destination = boundary.readLease(boundary.candidateRoot)!;
    expect(boundary.readLease()).toBeUndefined();
    expect(destination.owner).toBe(before.owner);
    expect(JSON.parse(String(destination.payload_json))).toMatchObject({
      helper,
      action: { kind: "triage", phase: "running" },
    });
    expect(
      (await boundary.readEvents()).find((event) => event.kind === "fixer")?.failure,
    ).toMatchObject({
      installationRoot: boundary.candidateRoot,
      error: "original failure",
      gateway: "preserve",
    });
    expect(await boundary.log()).toContain("exited code=7 signal=null");
    const sentinel = boundary.readSentinel()!;
    expect(JSON.parse(String(sentinel.payload_json))).toMatchObject({
      stats: { root: boundary.installRoot },
    });
    await boundary.native("stop");
    await closed(boundary);
    expect(boundary.readSentinel()).toEqual(sentinel);
  });

  itUnix("yields a switched installation to its live destination family", async () => {
    const winner = await start();
    await ready(winner);
    expect(await winner.control("commit")).toBe("committed");
    await fixing(winner);
    const held = winner.readLease();
    const members = (await winner.members()).filter((member) => member.alive);
    const boundary = await start("update", undefined, undefined, undefined, winner.installRoot);
    await ready(boundary);
    expect(await boundary.control("park")).toBe("parked");
    expect(await boundary.control("commit")).toBe("committed");
    boundary.parent.kill();
    expect(await boundary.exit).toEqual({ code: 7, signal: null });
    expect(await boundary.log()).toContain("already owned");
    expect(winner.readLease()).toEqual(held);
    expect((await winner.members()).filter((member) => member.alive)).toEqual(members);
    expect(boundary.readLease()).toBeUndefined();
    const events = await boundary.readEvents();
    expect(
      events.filter((event) => ["fixer", "attached", "start", "restart"].includes(event.kind)),
    ).toEqual([]);
    expect(events.filter((event) => event.kind === "triage-queued")).toHaveLength(1);
    await winner.native("stop");
    await closed(winner);
  });

  itUnix("refuses an inactive installed unit replaced after update parking", async () => {
    const boundary = await start("update", "unit");
    await ready(boundary);
    expect(await boundary.control("park")).toBe("parked");
    expect(await boundary.control("commit")).toBe("committed");
    boundary.parent.kill();
    await vi.waitFor(
      async () => {
        const events = await boundary.readEvents();
        expect(
          events.some((event) => event.kind === "attached") ||
            (await boundary.log()).includes("could not verify the installed service"),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect((await boundary.readEvents()).filter((event) => event.kind === "attached")).toEqual([]);
    expect((await boundary.readEvents()).filter((event) => event.kind === "fixer")).toEqual([]);
    expect(await boundary.exit).toEqual({ code: 7, signal: null });
  });

  itUnix.each(["helper", "runner", "disconnect", "lease", "cancelled", "scope"] as const)(
    "cleans the cgroup after %s loss without late restoration",
    async (loss) => {
      const boundary = await start("startup", undefined, undefined, async (root) => {
        if (loss !== "runner" && loss !== "disconnect") {
          return;
        }
        const file = path.join(root, "candidate.mjs");
        let script = await fs.readFile(file, "utf8");
        // Root exit must retire descendants even when both stdout and IPC remain open.
        script = script.replace(
          "detached:true,stdio:'ignore'",
          loss === "runner"
            ? "detached:true,stdio:['ignore','inherit','ignore',3]"
            : "detached:true,stdio:['ignore','inherit','ignore']",
        );
        if (loss === "disconnect") {
          // An unresponsive executor cannot run its own cooperative cancellation.
          script = script.replace(
            /^import \{ acceptTriageContinuation \} from .*;$/m,
            `
import { once } from 'node:events';
const acceptTriageContinuation = async () => {
  const grant = once(process, 'message');
  process.send({type:'triage-ready',version:2});
  return {failure:(await grant)[0].failure,signal:new AbortController().signal};
};`,
          );
          script = script.replace(
            "event('branch',{child:branch.pid});",
            `
event('branch',{child:branch.pid});
const watcher = fs.watch(${JSON.stringify(root)}, (_event, name) => {
  if (name !== 'disconnect') return;
  watcher.close();
  process.disconnect();
});`,
          );
        }
        await fs.writeFile(file, script);
      });
      await ready(boundary);
      expect(await boundary.control("commit")).toBe("committed");
      await fixing(boundary);
      if (loss === "helper") {
        boundary.helper.kill("SIGKILL");
      } else if (loss === "lease") {
        boundary.replaceLease();
      } else if (loss === "cancelled" || loss === "scope") {
        boundary.replaceLease(loss);
      } else if (loss === "disconnect") {
        await fs.writeFile(path.join(boundary.root, "disconnect"), "");
      } else {
        process.kill(
          (await boundary.readEvents()).find((event) => event.kind === "fixer")!.pid,
          "SIGKILL",
        );
      }
      await closed(boundary);
    },
  );

  itUnix.each(["scope", "placement"] as const)(
    "refuses readiness and fixer before verified %s attachment",
    async (fault) => {
      const boundary = await start("startup", fault);
      await boundary.exit;
      expect(boundary.output()).not.toContain("READY");
      expect((await boundary.readEvents()).filter((event) => event.kind === "fixer")).toEqual([]);
      expect(await boundary.log()).toContain("native scope ownership could not be verified");
    },
  );
});
