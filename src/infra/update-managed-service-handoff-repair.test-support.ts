import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { expect } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import type {
  ManagedRepairBoundary,
  ManagedServiceManagerBoundaryRunner,
} from "./update-managed-service-handoff-boundary-contract.test-support.js";

export function readManagedRepairEffects(root: string) {
  return {
    firstSpawn: existsSync(path.join(root, "repair-spawn-first")),
    secondSpawn: existsSync(path.join(root, "repair-spawn-second")),
    firstExec: existsSync(path.join(root, "candidate", "repair-first-exec.txt")),
    secondExec: existsSync(path.join(root, "candidate", "repair-second-exec.txt")),
    secondWrite: existsSync(path.join(root, "candidate", "repair-second-write.txt")),
  };
}

export async function releaseManagedRepairInference(
  repair: ManagedRepairBoundary,
  root: string,
  configPath: string,
) {
  const firstEffect = path.join(root, "candidate", "repair-first-exec.txt");
  expect(Number(await fs.readFile(firstEffect, "utf8"))).toBeGreaterThan(0);
  if (repair.revoke) {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.commands.ownerAllowFrom = [];
    await fs.writeFile(configPath, JSON.stringify(config));
  }
  repair.releaseInference();
}

export function managedRepairConfig(baseUrl: string): OpenClawConfig {
  const modelRef = "repair-test/repair-model";
  return {
    commands: { ownerAllowFrom: ["slack:owner"] },
    channels: { slack: { enabled: true } },
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        model: { primary: modelRef },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        systemAgent: { agentId: "operator" },
        skipBootstrap: true,
        skills: [],
        sandbox: { mode: "off" },
      },
      entries: { operator: {} },
    },
    models: {
      mode: "replace",
      providers: {
        "repair-test": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "synthetic-repair-key",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "repair-model",
              name: "Repair model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

function managedRepairSpawnPreload(root: string): string {
  return `const fs = require("node:fs");
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = function(command, args, options) {
      // Rehearsal strips NODE_OPTIONS; carry the recorder only to its owned supervisor workers.
      if (command === process.execPath && Array.isArray(args) && args.length === 1 &&
          ${JSON.stringify([runtimeProcessEntrypoints.serviceChildRelay, runtimeProcessEntrypoints.serviceChildGroupAnchor].map((entry) => path.resolve("dist", entry.distWorkerPath)))}.includes(args[0])) {
        args = ["--require", __filename, ...args];
      }
      // Source orchestration consumes the packaged SQLite worker from the completed build.
      if (Array.isArray(args) && args.length === 3 && args[0] === "--import" && args[1] === "tsx" &&
          args[2] === ${JSON.stringify(path.resolve("src/infra/update-candidate-state.worker.ts"))}) {
        args = [${JSON.stringify(path.resolve("dist", runtimeProcessEntrypoints.updateCandidateState.distWorkerPath))}];
      }
      const script = Array.isArray(args) ? args.join(" ") : "";
      for (const effect of ["first", "second"]) {
        if (script.includes("node -e") && script.includes("repair-" + effect + "-exec.txt")) {
          fs.writeFileSync(${JSON.stringify(path.join(root, "repair-spawn-"))} + effect, "spawned");
        }
      }
      return spawn.call(this, command, args, options);
    };
    require("node:module").syncBuiltinESMExports();`;
}

export async function prepareManagedRepairSpawnEnv(root: string, env: NodeJS.ProcessEnv) {
  const preloadPath = path.join(root, "repair-spawn-preload.cjs");
  await fs.writeFile(preloadPath, managedRepairSpawnPreload(root));
  // Match cli-process: TSX's synchronous esbuild worker IPC can otherwise wait forever.
  return { ...env, ESBUILD_WORKER_THREADS: "0", NODE_OPTIONS: `--require ${preloadPath}` };
}

export async function managedRepairUpdaterScript(params: {
  root: string;
  runId: string;
  sourceRuntimeImport: string;
  phase: ManagedRepairBoundary["phase"];
}): Promise<string> {
  const candidate = path.join(params.root, "candidate");
  await fs.mkdir(candidate);
  await fs.symlink(path.resolve("dist"), path.join(candidate, "dist"), "dir");
  const repairModule = new URL("../cli/update-cli/update-command-repair.ts", import.meta.url).href;
  const admissionModule = new URL("../cli/update-cli/update-command-run.ts", import.meta.url).href;
  const sentinelModule = new URL("./update-control-plane-sentinel.ts", import.meta.url).href;
  const sourceRuntimePaths = ["js", "ts"].map(
    (extension) => new URL(`./update-repair-agent.runtime.${extension}`, import.meta.url).pathname,
  );
  const builtRuntime = new URL("../../dist/update-repair-agent.runtime.js", import.meta.url).href;
  const installRoot = params.phase === "verifying" ? candidate : params.root;
  return `void (async () => {
    // Source workers resolve the checkout's toolchain from the driver cwd.
    process.chdir(${JSON.stringify(path.resolve("."))});
    ${params.sourceRuntimeImport}
    const fs = require("node:fs");
    // Match the repair E2E's compiled host execution without replacing source admission or orchestration.
    const sourceRuntimePaths = new Set(${JSON.stringify(sourceRuntimePaths)});
    const { registerHooks } = require("node:module");
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if ((specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL &&
            sourceRuntimePaths.has(new URL(specifier, context.parentURL).pathname)) {
          return { url: ${JSON.stringify(builtRuntime)}, shortCircuit: true };
        }
        const resolved = nextResolve(specifier, context);
        return sourceRuntimePaths.has(new URL(resolved.url).pathname)
          ? { url: ${JSON.stringify(builtRuntime)}, shortCircuit: true }
          : resolved;
      },
    });
    process.stderr.write("repair-boundary: loading admission\\n");
    const { runUpdateCommandRepair } = await import(${JSON.stringify(repairModule)});
    const { admitUpdateCommandRun } = await import(${JSON.stringify(admissionModule)});
    const { UPDATE_RUN_ID_ENV } = await import(${JSON.stringify(sentinelModule)});
    if (process.env[UPDATE_RUN_ID_ENV] !== ${JSON.stringify(params.runId)}) {
      throw new Error("The helper did not transfer the admitted update run.");
    }
    const run = await admitUpdateCommandRun({ opts: {}, root: ${JSON.stringify(installRoot)} });
    process.stderr.write("repair-boundary: admitted\\n");
    if (run.runId !== ${JSON.stringify(params.runId)}) {
      throw new Error("Repair admission did not preserve the chat update run.");
    }
    const repair = await runUpdateCommandRepair({
      root: ${JSON.stringify(installRoot)},
      candidateRoot: ${JSON.stringify(candidate)},
      env: run.env,
      run,
      phase: ${JSON.stringify(params.phase)},
      onEvent: ({ type }) => process.stderr.write("repair-boundary: " + type + "\\n"),
      result: { status: "error", mode: "npm", reason: "candidate-validation-failed", steps: [], durationMs: 0 },
      validate: async () => {
        const ok = fs.existsSync(${JSON.stringify(path.join(candidate, "repair-second-exec.txt"))}) &&
          fs.existsSync(${JSON.stringify(path.join(candidate, "repair-second-write.txt"))});
        return { ok, score: ok ? 1 : 0, summary: ok ? "Both repair effects verified." : "Repair effects pending." };
      },
    });
    process.stdout.write(JSON.stringify({ root: ${JSON.stringify(params.root)}, mode: "npm",
      status: repair.status === "repaired" ? "skipped" : "error", reason: repair.reason || "already-current", steps: [] }));
    process.exit(repair.status === "repaired" ? 0 : 1);
  })().catch((error) => { console.error(error); process.exit(18); });`;
}

function writeEffects(response: ServerResponse, second: boolean) {
  const marker = second ? "repair-second-exec.txt" : "repair-first-exec.txt";
  const calls = [
    {
      name: "exec",
      arguments: JSON.stringify({
        command: `node -e "require('node:fs').writeFileSync('${marker}', String(process.pid))"`,
      }),
    },
    ...(second
      ? [
          {
            name: "write",
            arguments: JSON.stringify({ path: "repair-second-write.txt", content: "written" }),
          },
        ]
      : []),
  ].map((call, index) => ({
    name: call.name,
    arguments: call.arguments,
    type: "function_call",
    id: `fc_repair_${second}_${index}`,
    call_id: `call_repair_${second}_${index}`,
    status: "completed",
  }));
  writeOpenAiResponsesSse(response, [
    ...calls.flatMap((item, output_index) => [
      {
        type: "response.output_item.added",
        output_index,
        item: { ...item, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index,
        arguments: item.arguments,
      },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: `resp_repair_${second}`,
        status: "completed",
        output: calls,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

export async function runManagedRepairAuthorityBoundary(
  runBoundary: ManagedServiceManagerBoundaryRunner,
  phase: ManagedRepairBoundary["phase"],
  revoke: boolean,
) {
  let markPending!: () => void;
  const inferencePending = new Promise<void>((resolve) => {
    markPending = resolve;
  });
  let releaseInference!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseInference = resolve;
  });
  const errors: unknown[] = [];
  let toolResponses = 0;
  let result: Awaited<ReturnType<typeof runBoundary>> | undefined;
  await withServer(
    (request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "repair-model", object: "model" }] }));
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(await readText(request)) as { tools?: Array<{ name?: string }> };
        if (body.tools?.some((tool) => tool.name === "exec") && toolResponses < 2) {
          const second = toolResponses++ === 1;
          if (second) {
            markPending();
            await released;
          }
          writeEffects(response, second);
          return;
        }
        writeOpenAiResponsesText(response, {
          text: toolResponses
            ? 'REPAIR_RESULT: {"status":"fixed","summary":"Repair effects requested."}'
            : "OK",
          messageId: `msg_repair_${toolResponses}`,
          responseId: `resp_repair_${toolResponses}`,
        });
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end();
      });
    },
    async (baseUrl) => {
      try {
        result = await runBoundary("systemd", {
          controlDisconnect: "transferred",
          validationResult: "skipped",
          requester: { channel: "slack", accountId: "primary", senderId: "owner" },
          ledger: true,
          helperExitCode: revoke ? 1 : 0,
          repair: { phase, baseUrl, revoke, inferencePending, releaseInference },
        });
      } finally {
        releaseInference();
      }
    },
  );
  expect(errors).toEqual([]);
  expect(toolResponses).toBe(2);
  if (!result) {
    throw new Error("Repair boundary did not run.");
  }
  return result;
}
