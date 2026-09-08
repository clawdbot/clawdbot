import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setCliSessionBinding } from "../agents/cli-session.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("CLI fork recovery process", () => {
  it("keeps a concurrent durable rebind when a stale fork reports its successor", async () => {
    const root = tempDirs.make("openclaw-cli-fork-recovery-");
    const stateDir = path.join(root, "state");
    const tmpDir = path.join(root, "tmp");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "plugin");
    const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
    const sessionKey = "agent:main:cli-fork-process";
    const sourceCliSessionId = "source-cli-session";
    const newerCliSessionId = "newer-cli-session";
    const successorCliSessionId = "stale-successor-session";
    const checkpointId = "source-checkpoint";
    const backendScript = path.join(root, "backend.mjs");
    const rebindScript = path.join(root, "rebind.mjs");
    const spawnLog = path.join(root, "spawn.jsonl");
    await Promise.all([
      fs.mkdir(tmpDir, { recursive: true }),
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(pluginDir, { recursive: true }),
    ]);

    await writeProofPlugin({
      pluginDir,
      backendScript,
      rebindScript,
    });
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        session: { store: path.join(stateDir, "agents/{agentId}/sessions/sessions.json") },
        plugins: {
          allow: ["cli-fork-process-proof"],
          load: { paths: [pluginDir] },
          entries: { "cli-fork-process-proof": { enabled: true } },
        },
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: "proof-cli/proof-model" },
            models: { "proof-cli/proof-model": { agentRuntime: { id: "proof-cli" } } },
          },
        },
      }),
    );

    const entry: InternalSessionEntry = {
      sessionId: "openclaw-process-session",
      lifecycleRevision: "process-lifecycle",
      activeWriterRunId: "process-writer",
      updatedAt: 1,
    };
    setCliSessionBinding(entry, "proof-cli", {
      sessionId: sourceCliSessionId,
      forceReuse: true,
      forkNextResume: true,
      resumeCheckpointId: checkpointId,
    });
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    closeOpenClawAgentDatabasesForTest();

    const result = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
        "agent",
        "--local",
        "--session-key",
        sessionKey,
        "--model",
        "proof-cli/proof-model",
        "--message",
        "prove stale fork ownership",
        "--json",
      ],
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: tmpDir,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: stateDir,
        PR135168_BACKEND_SCRIPT: backendScript,
        PR135168_NEWER_CLI_SESSION_ID: newerCliSessionId,
        PR135168_REBIND_SCRIPT: rebindScript,
        PR135168_SESSION_KEY: sessionKey,
        PR135168_SPAWN_LOG: spawnLog,
        PR135168_STORE_PATH: storePath,
        PR135168_SUCCESSOR_CLI_SESSION_ID: successorCliSessionId,
        VITEST: undefined,
      },
    });

    expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain(
      "CLI turn failed and its fork successor could not be persisted",
    );
    closeOpenClawAgentDatabasesForTest();
    expect(
      loadSessionEntryReadOnly({ sessionKey, storePath })?.cliSessionBindings?.["proof-cli"]
        ?.sessionId,
    ).toBe(newerCliSessionId);
    const spawn = JSON.parse((await fs.readFile(spawnLog, "utf8")).trim()) as {
      argv: string[];
    };
    expect(spawn.argv).toEqual([
      "--resume",
      sourceCliSessionId,
      "--fork-session",
      "--resume-session-at",
      checkpointId,
    ]);
  });
});

async function writeProofPlugin(params: {
  pluginDir: string;
  backendScript: string;
  rebindScript: string;
}): Promise<void> {
  await Promise.all([
    fs.writeFile(
      path.join(params.pluginDir, "package.json"),
      JSON.stringify({
        name: "cli-fork-process-proof",
        private: true,
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    ),
    fs.writeFile(
      path.join(params.pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cli-fork-process-proof",
        name: "CLI fork process proof",
        cliBackends: ["proof-cli"],
        activation: { onStartup: false },
        modelCatalog: {
          providers: {
            "proof-cli": {
              models: [
                {
                  id: "proof-model",
                  name: "Proof model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
          discovery: { "proof-cli": "static" },
        },
        configSchema: { type: "object", additionalProperties: false },
      }),
    ),
    fs.writeFile(
      path.join(params.pluginDir, "index.js"),
      `import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const need = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("missing " + name);
  return value;
};
export default {
  id: "cli-fork-process-proof",
  name: "CLI fork process proof",
  register(api) {
    api.registerCliBackend({
      id: "proof-cli",
      modelProvider: "proof-cli",
      config: {
        command: process.execPath,
        args: [need("PR135168_BACKEND_SCRIPT")],
        resumeArgs: [need("PR135168_BACKEND_SCRIPT"), "--resume", "{sessionId}"],
        output: "json",
        resumeOutput: "json",
        input: "stdin",
        sessionMode: "existing",
        sessionIdFields: ["session_id"],
        forkArg: "--fork-session",
        resumeAtArg: "--resume-session-at",
        systemPromptWhen: "never",
        serialize: true
      },
      async prepareExecution() {
        return {
          beforeExecution: async () => {
            await execFileAsync(process.execPath, ["--import", "tsx", need("PR135168_REBIND_SCRIPT")]);
          }
        };
      }
    });
  }
};
`,
    ),
    fs.writeFile(
      params.backendScript,
      `import fs from "node:fs/promises";
const stdin = [];
for await (const chunk of process.stdin) stdin.push(chunk);
await fs.appendFile(process.env.PR135168_SPAWN_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ result: "stale recovery ran", session_id: process.env.PR135168_SUCCESSOR_CLI_SESSION_ID }) + "\\n");
`,
    ),
    fs.writeFile(
      params.rebindScript,
      `const accessor = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.sessionAccessor).href)});
const cliSession = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cliSession).href)});
const scope = { sessionKey: process.env.PR135168_SESSION_KEY, storePath: process.env.PR135168_STORE_PATH };
const current = accessor.loadSessionEntry({ ...scope, readConsistency: "latest" });
if (!current) throw new Error("proof session row missing");
const rebound = structuredClone(current);
cliSession.setCliSessionBinding(rebound, "proof-cli", { sessionId: process.env.PR135168_NEWER_CLI_SESSION_ID, forceReuse: true });
if (!await accessor.replaceSessionEntry(scope, rebound)) throw new Error("proof rebind failed");
`,
    ),
  ]);
}
