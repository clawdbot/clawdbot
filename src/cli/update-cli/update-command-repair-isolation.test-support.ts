import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function repairIsolationConfig(baseUrl: string, gatewayPort: number): OpenClawConfig {
  const modelRef = "repair-test/repair-model";
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token: "synthetic-repair-gateway-token" },
    },
    plugins: { slots: { memory: "none" } },
    logging: { level: "info" },
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

function writeExecCall(response: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_isolation_exec",
    call_id: "call_isolation_exec",
    name: "exec",
    arguments: JSON.stringify({
      command: "node ./repair-probe.mjs",
      // Join the probe for its existing command deadline before declaring completion.
      yieldMs: 120_000,
      timeoutSeconds: 120,
    }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_isolation_exec",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

export function repairIsolationProvider() {
  const errors: unknown[] = [];
  let issuedRepair = false;
  let requestCount = 0;
  return {
    errors,
    handle: (request: import("node:http").IncomingMessage, response: ServerResponse) => {
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
        const body = JSON.parse(await readText(request)) as {
          tools?: Array<{ name?: string }>;
        };
        requestCount += 1;
        if (!issuedRepair && body.tools?.some((tool) => tool.name === "exec")) {
          issuedRepair = true;
          writeExecCall(response);
          return;
        }
        writeOpenAiResponsesText(response, {
          text: issuedRepair
            ? 'REPAIR_RESULT: {"status":"fixed","summary":"Completed the candidate repair probe."}'
            : "OK",
          messageId: `msg_isolation_${requestCount}`,
          responseId: `resp_isolation_${requestCount}`,
        });
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end();
      });
    },
  };
}

export async function writeRepairCandidate(candidate: string, configChange: boolean) {
  await fs.mkdir(candidate, { recursive: true });
  await fs.symlink(path.join(process.cwd(), "dist"), path.join(candidate, "dist"), "dir");
  for (const file of ["openclaw.mjs", "node-version.mjs", "package.json"]) {
    await fs.copyFile(path.join(process.cwd(), file), path.join(candidate, file));
  }
  await fs.writeFile(
    path.join(candidate, "repair-probe.mjs"),
    `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const configChange = ${JSON.stringify(configChange)};
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const database = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite'));
const before = database.prepare('SELECT value FROM isolation_evidence').get().value;
if (configChange) {
  database.exec("UPDATE isolation_evidence SET value = 'repaired-copy'");
}
database.close();
let doctor;
if (configChange) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.logging = { ...config.logging, level: 'debug' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const outcome = spawnSync(process.execPath, ['./openclaw.mjs', 'doctor', '--fix', '--non-interactive'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 90_000,
  });
  doctor = { status: outcome.status, error: outcome.error?.message,
    output: outcome.status === 0 ? undefined : (outcome.stdout + outcome.stderr).slice(-4000) };
}
fs.writeFileSync('repair-proof.json', JSON.stringify({
  stateDir, configPath, workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
  cwd: process.cwd(), before, doctor,
}));
`,
  );
}
