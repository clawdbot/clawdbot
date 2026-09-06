import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  formatUpdateAncestryBlockMessage,
  gatewayAncestryBlockMessage,
} from "./update-command-handoff.js";

const tempDirs = createTrackedTempDirs();
afterEach(() => tempDirs.cleanup());

it.runIf(process.platform === "darwin").each(["cancel", "cancel-output-first", "transfer"])(
  "settles the initiating CLI's owned handoff lifetime: %s",
  async (mode) => {
    const root = await fs.realpath(await tempDirs.make("openclaw-cli-handoff-lifetime-"));
    const callerPath = path.join(root, "caller.mjs");
    const preloadPath = path.join(root, "handoff-order.cjs");
    const tracePath = path.join(root, "trace.jsonl");
    const resultPath = path.join(root, "result.json");
    const managerPath = path.join(root, "manager-calls");
    const leasePath = path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", type: "module" }),
    );
    await fs.writeFile(path.join(root, "dist/index.mjs"), "throw new Error('unexpected updater');");
    // The task-owned manager rejects every service command; host launchd is never invoked.
    await fs.writeFile(
      path.join(root, "launchctl"),
      `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(managerPath)}, 'called\\n');process.exit(61);`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      preloadPath,
      `
const fs=require('node:fs');
const record=(event,data={})=>fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event,...data})+'\\n');
if(process.argv[1]===${JSON.stringify(callerPath)} && ${mode !== "transfer"}) {
  const sqlite=require('node:sqlite'), Original=sqlite.DatabaseSync;
  sqlite.DatabaseSync=new Proxy(Original,{construct(target,args,newTarget) {
    if(String(args[0])===${JSON.stringify(path.join(root, "state/openclaw.sqlite"))}) {
      const db=new Original(${JSON.stringify(leasePath)},{readOnly:true});
      const lease=db.prepare('SELECT owner FROM managed_update_handoffs WHERE install_root=?').get(${JSON.stringify(root)});
      db.close();record('publication-denied',{ready:!!lease});
      throw Object.assign(new Error('fixture publication denied'),{code:'SQLITE_CANTOPEN'});
    }
    return Reflect.construct(target,args,newTarget);
  }});
  require('node:module').syncBuiltinESMExports();
} else if(process.argv[1]?.endsWith('/handoff.cjs')) {
  const params=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(params.updateLeaseKey===${JSON.stringify(root)}) {
    if(${mode === "cancel-output-first"}) {
      // Close only helper output before native exit; the initiating CLI has no keepalive.
      process.once('beforeExit',()=>{record('helper-output-closed');process.stdout.end();setTimeout(()=>{},100);});
    }
    process.once('exit',()=>record('helper-exit'));
  }
}`,
    );
    await fs.writeFile(
      callerPath,
      `
import fs from 'node:fs';
import {handoffUpdateFromGateway} from ${JSON.stringify(new URL("./update-command-handoff.ts", import.meta.url).href)};
try {
  const transferred=await handoffUpdateFromGateway({state:{env:process.env,runtime:{status:'running',pid:process.ppid}},root:${JSON.stringify(root)},mode:'npm',opts:{json:true},timeoutMs:10000,nodeRunner:process.execPath,stopProgress:()=>{}});
  fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event:'caller-transferred',transferred})+'\\n');
} catch(error) {
  fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event:'caller-error'})+'\\n');
  process.stdout.write(JSON.stringify({code:error.code})+'\\n');process.exitCode=23;
}`,
    );
    const gatewayPath = path.join(root, "gateway.cjs");
    await fs.writeFile(
      gatewayPath,
      `
const fs=require('node:fs'),{spawn}=require('node:child_process');process.stdin.resume();
const child=spawn(process.execPath,['--import',${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href)},${JSON.stringify(callerPath)}],{env:process.env,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
child.once('close',(code,signal)=>{fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code,signal,stdout,stderr}));child.stdin.destroy();});
process.stdin.once('end',()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');process.stdin.destroy();});`,
    );
    const gateway = spawn(process.execPath, [gatewayPath], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.handoff-test.${process.pid}`,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}`,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = new Promise<void>((resolve) => {
      gateway.once("close", () => resolve());
    });
    const readLease = () => {
      const db = new DatabaseSync(leasePath, { readOnly: true });
      try {
        return db
          .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root=?")
          .get(root);
      } finally {
        db.close();
      }
    };
    try {
      await expect.poll(() => fs.readFile(resultPath, "utf8"), { timeout: 20_000 }).toBeDefined();
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      await expect.poll(readLease).toBeUndefined();
      expect(gateway.exitCode).toBeNull();
      expect(result.code, result.stderr).toBe(mode === "transfer" ? 0 : 23);
      const trace = (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (mode === "transfer") {
        expect(trace[0]).toEqual({ event: "caller-transferred", transferred: true });
      } else {
        expect(JSON.parse(result.stdout)).toEqual({ code: "SQLITE_CANTOPEN" });
        expect(await fs.readFile(managerPath, "utf8").catch(() => "")).toBe("");
        expect(trace[0]).toEqual({ event: "publication-denied", ready: true });
        if (mode === "cancel-output-first") {
          expect(trace.map((row) => row.event)).toEqual([
            "publication-denied",
            "helper-output-closed",
            "helper-exit",
            "caller-error",
          ]);
        }
      }
    } finally {
      gateway.stdin.end();
      await closed;
      await expect.poll(readLease).toBeUndefined();
      await expect.poll(() => fs.readFile(tracePath, "utf8")).toContain('"event":"helper-exit"');
    }
  },
);

describe("gatewayAncestryBlockMessage", () => {
  it("never advises stopping the gateway service or running update from the caller", () => {
    const message = gatewayAncestryBlockMessage(process.pid);
    expect(message).toContain("inside the gateway process tree");
    expect(message).toContain("from a shell outside the gateway service");
    expect(message).not.toContain("stop the gateway service first");
    expect(message).not.toContain("openclaw update");
  });

  it("returns undefined when the pid is not an ancestor", () => {
    expect(gatewayAncestryBlockMessage(2)).toBeUndefined();
  });
});

describe("formatUpdateAncestryBlockMessage", () => {
  it("adds the chat handoff advice only to ancestry blocks", () => {
    const ancestry = gatewayAncestryBlockMessage(process.pid) ?? "";
    expect(formatUpdateAncestryBlockMessage(ancestry)).toContain("/update");
    expect(formatUpdateAncestryBlockMessage("service inspection unavailable")).toBe(
      "service inspection unavailable",
    );
  });
});
