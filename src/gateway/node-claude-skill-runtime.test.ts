import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { executeNodeClaudeRun } from "../agents/cli-runner/execute-node-claude.js";
import { createLibrarySkillWorkshopTool } from "../agents/tools/skill-workshop-tool-library.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { NODE_CLAUDE_SKILLS_CAPABILITY } from "../infra/node-claude-skill-protocol.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../infra/node-commands.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { resolveNodeHostGatewayPlatformIdentity } from "../node-host/gateway-platform-identity.js";
import { decodeClaudeCliNodeRunParams } from "../node-host/invoke-agent-cli-claude-params.js";
import { runClaudeCliNodeCommand } from "../node-host/invoke-agent-cli-claude.js";
import type { NodeInvokeRequestPayload } from "../node-host/invoke-types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  loadSkillLibrarySelection,
  seedSkillLibrarySelection,
} from "../skills/library/selection.js";
import { listSkillLibrary, readSkillLibrary, saveSkillLibrary } from "../skills/library/service.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { invokeNodeClaudeCliRun } from "./node-agent-cli-runtime.js";
import { NodeRegistry } from "./node-registry.js";
import {
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareGatewaySkillAuthoring } from "./skill-library-authoring.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const content =
  "---\nname: guide\ndescription: A pinned node procedure\n---\n# Guide\nRun scripts/check.sh and read references/data.bin.\n";

async function fixture(
  source: string,
  options: { managed?: boolean; authoring?: boolean; capability?: boolean } = {},
) {
  const root = await fs.realpath(temps.make("node-skill-wire-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  const executable = path.join(root, "claude.cjs");
  await fs.writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const profile = ensureProfileForEmail("requester@example.test");
  ensureProfileForEmail("collaborator@example.test");
  const registry = new NodeRegistry();
  const placements = createWorkerSessionPlacementStore();
  const gateway = {
    nodeRegistry: registry,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  gateway.workerSessionPlacementService = placements;
  const owner: SkillLibraryRequestOwner = {
    context: gateway,
    client: {
      authenticatedUserProfile: { profileId: profile.id },
      connect: { scopes: ["operator.read", "operator.write"] },
    } as SkillLibraryRequestOwner["client"],
  };
  const authority = libraryAuthority(owner);
  const saved = options.managed
    ? await saveSkillLibrary(authority, {
        slug: "guide",
        expectedRevision: null,
        content,
        files: [
          { path: "scripts/check.sh", content: "#!/bin/sh\nprintf pinned", executable: true },
          {
            path: "references/data.bin",
            content: Buffer.alloc(150_000, 129).toString("base64"),
            encoding: "base64",
          },
        ],
      })
    : undefined;
  const pins = seedSkillLibrarySelection(authority);
  const sessionKey = "agent:main:node-skills";
  const sessionId = "node-skills";
  const entry = {
    sessionId,
    updatedAt: 1,
    execHost: "node" as const,
    execNode: "node-1",
    execCwd: workspace,
    skillLibrarySelections: pins,
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
  const runId = "node-skill-turn";
  const claim = placements.claimTurn({
    agentId: "main",
    sessionKey,
    sessionId,
    owner: { kind: "local" },
    claimId: "node-skill-claim",
    runId,
  });
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "test");
  const admitted = await admission.admit("plugin-harness");
  const capability = options.authoring
    ? prepareGatewaySkillAuthoring(owner, sessionKey, true)
    : undefined;
  capability?.bind(admitted);
  const snapshot = options.managed
    ? {
        ...buildSkillSnapshot(workspace, { entries: loadSkillLibrarySelection(pins) }),
        librarySelections: pins,
      }
    : undefined;
  const context = buildPreparedCliRunContext({
    workspaceDir: workspace,
    sessionKey,
    sessionId,
    sessionEntry: entry,
    runId,
    agentId: "main",
    skillsSnapshot: snapshot,
    timeoutMs: 10_000,
  });
  // Use the real admission/capability; the factory only supplies irrelevant CLI defaults.
  context.params.admittedRunContext = admitted;
  context.params.skillLibraryAuthoring = capability;
  context.nodeSkillWorkshop = capability ? createLibrarySkillWorkshopTool(capability) : undefined;
  const controller = new AbortController();
  const tasks: Promise<void>[] = [];
  let endpoint: ReturnType<typeof createNodeDuplexEndpoint> | undefined;
  let currentFrame: NodeInvokeRequestPayload | undefined;
  let wireBytes = 0;
  const requests: unknown[] = [];
  const progress = (chunk: string, seq: number) =>
    registry.handleInvokeProgress({
      invokeId: currentFrame!.id,
      nodeId: "node-1",
      connId: "connection-1",
      chunk,
      seq,
    });
  const nodeClient = {
    async request<T>(_method: string, params?: unknown): Promise<T> {
      const value = params as { chunk: string; seq: number };
      progress(value.chunk, value.seq);
      return {} as T;
    },
  };
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(raw: string) {
      wireBytes = Math.max(wireBytes, Buffer.byteLength(raw));
      const event = JSON.parse(raw) as {
        event: string;
        payload: NodeInvokeRequestPayload & { payloadJSON: string };
      };
      if (event.event === "node.invoke.input") {
        endpoint!.receive(event.payload.payloadJSON);
        return;
      }
      if (event.event === "node.invoke.cancel") {
        controller.abort();
        return;
      }
      if (event.event !== "node.invoke.request") {
        return;
      }
      currentFrame = event.payload;
      requests.push(JSON.parse(currentFrame.paramsJSON!));
      const task = Promise.resolve().then(async () => {
        const frame = currentFrame!;
        const request = await decodeClaudeCliNodeRunParams(frame.paramsJSON);
        let seq = 0;
        endpoint = createNodeDuplexEndpoint({
          sendFrame: (text) => {
            expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
            progress(text, seq++);
          },
        });
        const io: OpenClawPluginNodeHostCommandIo = {
          signal: controller.signal,
          emitChunk: async () => {
            throw new Error("unexpected raw duplex output");
          },
          onInput: () => {
            throw new Error("unexpected unframed input");
          },
          frames: {
            send: (bytes) => endpoint!.send(bytes),
            onMessage: (listener) => {
              const unsubscribe = endpoint!.onMessage(listener);
              void endpoint!.sendReady();
              return unsubscribe;
            },
          },
        };
        try {
          const result = await runClaudeCliNodeCommand({
            client: nodeClient,
            frame,
            request,
            argv: [executable, ...request.argv],
            cwd: workspace,
            env: process.env as Record<string, string>,
            timeoutMs: 10_000,
            signal: controller.signal,
            skillIo: request.skillRuntime ? io : undefined,
          });
          registry.handleInvokeResult({
            id: frame.id,
            nodeId: "node-1",
            connId: "connection-1",
            ok: true,
            payload: {
              exitCode: result.exitCode,
              stderrTail: result.stderr,
              truncated: result.truncated,
            },
          });
        } catch (error) {
          registry.handleInvokeResult({
            id: frame.id,
            nodeId: "node-1",
            connId: "connection-1",
            ok: false,
            error: { message: String(error) },
          });
        }
      });
      tasks.push(task);
    },
  };
  registry.register(
    {
      connId: "connection-1",
      socket,
      connect: {
        client: {
          id: "node-host",
          mode: "node",
          version: "test",
          ...resolveNodeHostGatewayPlatformIdentity(process.platform),
        },
        device: { id: "node-1" },
        caps: options.capability === false ? [] : [NODE_CLAUDE_SKILLS_CAPABILITY],
        commands: [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND],
      },
    } as GatewayWsClient,
    { pairingIdentity: "node-1", pairingGeneration: "generation-1" },
  );
  let output = "";
  const execute = (stdin = "hello") =>
    withPluginRuntimeGatewayRequestScope(
      { context: gateway, client: owner.client, isWebchatConnect: () => true },
      () =>
        executeNodeClaudeRun({
          context,
          nodePlacement: { nodeId: "node-1", cwd: workspace },
          executionArgs: ["-p"],
          stdinPayload: stdin,
          noOutputTimeoutMs: 5_000,
          consumeStdout: (text) => {
            output += text;
          },
          consumeStderr: () => {},
          deps: {
            invokeNodeClaudeCliRun,
            registerExecApprovalRequestForHostOrThrow: async () => {
              throw new Error("unexpected approval");
            },
            resolveRegisteredExecApprovalDecision: async () => {
              throw new Error("unexpected approval");
            },
          },
        }),
    );
  return {
    saved,
    pins,
    authority,
    context,
    root,
    workspace,
    placements,
    claim,
    admission,
    requests,
    registry,
    execute,
    output: () => output,
    maxWireBytes: () => wireBytes,
    completeInvocation() {
      registry.handleInvokeResult({
        id: currentFrame!.id,
        nodeId: "node-1",
        connId: "connection-1",
        ok: true,
        payload: { exitCode: 0, stderrTail: "", truncated: false },
      });
    },
    async close() {
      admission.close();
      controller.abort();
      registry.unregister("connection-1");
      endpoint?.close();
      await Promise.all(tasks);
    },
  };
}

describe("paired-node Claude skill invocation", () => {
  it("serializes pinned resources, rewrites references, executes support bytes, and removes node artifacts", async () => {
    const f = await fixture(
      `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
let input = ''; process.stdin.on('data', b => input += b); process.stdin.on('end', () => {
 const promptPath = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
 const prompt = fs.readFileSync(promptPath, 'utf8');
 const skillPath = prompt.split('<location>')[1].split('</location>')[0];
 const dir = path.dirname(skillPath), script = path.join(dir, 'scripts/check.sh');
 console.log(JSON.stringify({ type:'result', skillPath, prompt, input, readRoot:process.argv[process.argv.indexOf('--add-dir')+1], instruction:fs.readFileSync(skillPath,'utf8'), hash:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'references/data.bin'))).digest('hex'), mode:fs.statSync(script).mode & 511, executed:cp.execFileSync(script,{encoding:'utf8'}) }));
});`,
      { managed: true },
    );
    try {
      const selected = f.context.params.skillsSnapshot!.resolvedSkills![0]!;
      await saveSkillLibrary(f.authority, {
        skillId: f.saved!.entry.skillId,
        slug: "guide",
        expectedRevision: f.saved!.entry.revision,
        content: content + "Changed later.\n",
      });
      const result = await f.execute(
        `Read ${selected.filePath}; run ${selected.baseDir}/scripts/check.sh`,
      );
      expect(result.result.exitCode).toBe(0);
      const actual = JSON.parse(f.output()) as {
        skillPath: string;
        prompt: string;
        input: string;
        instruction: string;
        readRoot: string;
        hash: string;
        mode: number;
        executed: string;
      };
      expect(actual.instruction).toBe(content);
      expect(actual.executed).toBe("pinned");
      expect(actual.mode).toBe(0o500);
      expect(actual.hash).toBe(
        createHash("sha256").update(Buffer.alloc(150_000, 129)).digest("hex"),
      );
      expect(actual.prompt).toContain(f.pins[0]!.name);
      expect(actual.input).toContain(actual.skillPath);
      expect(actual.input).not.toContain(selected.baseDir);
      expect(actual.skillPath.startsWith(f.workspace)).toBe(false);
      expect(actual.skillPath.startsWith(`${actual.readRoot}${path.sep}`)).toBe(true);
      expect(f.requests[0]).toMatchObject({ skillRuntime: true });
      expect(JSON.stringify(f.requests)).not.toContain("files");
      expect(f.maxWireBytes()).toBeLessThan(16 * 1024);
      await vi.waitFor(async () =>
        expect(await fs.stat(actual.skillPath).catch(() => undefined)).toBeUndefined(),
      );
      expect(await fs.readdir(f.workspace)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("keeps the original request and raw progress for turns without managed skills or authoring", async () => {
    const f = await fixture(
      "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',result:s,args:process.argv.slice(2)})));",
    );
    try {
      const executed = await f.execute();
      expect(executed.result.exitCode, executed.result.stderr).toBe(0);
      expect(f.requests[0]).not.toHaveProperty("skillRuntime");
      expect(JSON.parse(f.output())).toEqual({ type: "result", result: "hello", args: ["-p"] });
    } finally {
      await f.close();
    }
  });

  it("requires the additive node capability before dispatching a selected bundle", async () => {
    const f = await fixture("process.exit(99)", { managed: true, capability: false });
    try {
      await expect(f.execute()).rejects.toThrow("Upgrade OpenClaw on the paired node");
      expect(f.requests).toEqual([]);
    } finally {
      await f.close();
    }
  });

  const authorScript = `
const fs=require('node:fs'); const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8'));
async function call(method,params,id){const r=await fetch(config.mcpServers.openclaw.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return r.json();}
(async()=>{await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'synthetic-claude',version:'1'}},1);
 const listed=await call('tools/list',{},2);
 const created=await call('tools/call',{name:'skill_workshop',arguments:{action:'create',name:'node-created',proposal_content:${JSON.stringify(content)},files:[{path:'scripts/task.sh',content:'#!/bin/sh\\nprintf owned',executable:true}]}},3);
 const receipt=JSON.parse(created.result.content[0].text);
 const updated=await call('tools/call',{name:'skill_workshop',arguments:{action:'update',skill_id:receipt.entry.skillId,expected_revision:receipt.entry.revision,name:'node-created',proposal_content:${JSON.stringify(content + "Updated on node.\n")}}},4);
 console.log(JSON.stringify({type:'result',listed,created,updated}));
})().catch(e=>{console.error(String(e));process.exitCode=1;});`;

  it("authors through the node MCP proxy using the actual host capability without a preselected skill", async () => {
    const f = await fixture(authorScript, { authoring: true });
    try {
      expect((await f.execute()).result.exitCode).toBe(0);
      const result = JSON.parse(f.output()) as {
        listed: {
          result: {
            tools: Array<{ name: string; inputSchema: { properties: { action: unknown } } }>;
          };
        };
      };
      expect(result.listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "skill_workshop",
      ]);
      expect(result.listed.result.tools[0]!.inputSchema.properties.action).toMatchObject({
        type: "string",
        enum: expect.arrayContaining(["create", "update"]),
      });
      const entries = listSkillLibrary(f.authority).entries;
      expect(entries).toHaveLength(1);
      const published = await readSkillLibrary(f.authority, entries[0]!.skillId);
      expect(published.content).toBe(content + "Updated on node.\n");
      expect(published.files[0]).toMatchObject({ path: "scripts/task.sh", executable: true });
      expect(Buffer.from(published.files[0]!.content, "base64").toString()).toBe(
        "#!/bin/sh\nprintf owned",
      );
      expect(f.context.params.skillsSnapshot).toBeUndefined();
      expect(JSON.stringify(f.requests)).not.toContain(f.authority.profileId);
    } finally {
      await f.close();
    }
  });

  it.each(["run-close", "claim-loss", "disconnect", "completion", "assignment-change"] as const)(
    "rejects publication after awaited file work when %s wins",
    async (failure) => {
      const f = await fixture(authorScript, { authoring: true });
      const publishing = createDeferredCore();
      const resume = createDeferredCore();
      const rename = fs.rename.bind(fs);
      const blocked = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(from).includes(".staging-")) {
          publishing.resolve();
          await resume.promise;
        }
        return rename(from, to);
      });
      let running: ReturnType<typeof f.execute> | undefined;
      try {
        running = f.execute();
        void running.catch(() => {});
        await Promise.race([
          publishing.promise,
          running.then(() => {
            throw new Error("Node turn ended before the publication boundary");
          }),
        ]);
        if (failure === "run-close") {
          f.admission.close();
        }
        if (failure === "claim-loss") {
          f.placements.releaseTurn(f.claim);
        }
        if (failure === "disconnect") {
          f.registry.unregister("connection-1");
        }
        if (failure === "completion") {
          f.completeInvocation();
        }
        if (failure === "assignment-change") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: f.context.params.sessionKey! },
            { ...f.context.params.sessionEntry!, execNode: "replacement-node" },
          );
        }
        resume.resolve();
        await running.catch(() => undefined);
        expect(listSkillLibrary(f.authority).entries).toEqual([]);
      } finally {
        resume.resolve();
        await running?.catch(() => undefined);
        await f.close();
        blocked.mockRestore();
      }
    },
  );
});
