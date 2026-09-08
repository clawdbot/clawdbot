import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareUnattendedUpdateRepair } from "./update-repair-agent.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

// Exercise the built runtime through Node's loader; Vitest's source-module graph
// stalls inside agent command execution before the synthetic provider is called.
vi.mock("./update-repair-agent.runtime.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(
    "../../dist/update-repair-agent.runtime.js",
  ) as typeof import("./update-repair-agent.runtime.js");
});

type ModelRequest = {
  model?: string;
  tools?: Array<{ name?: string }>;
  input?: Array<{ type?: string; call_id?: string; output?: string }>;
};

function writeRepairToolCall(response: ServerResponse, name: "exec" | "write"): void {
  const item = {
    type: "function_call",
    id: `fc_repair_${name}`,
    call_id: `call_repair_${name}`,
    name,
    arguments: JSON.stringify(
      name === "write"
        ? { path: "../outside-repair.txt", content: "must not escape" }
        : {
            command:
              "node -e \"require('node:fs').writeFileSync('repair-proof.txt', [process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION, process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR, process.env.OPENCLAW_SERVICE_REPAIR_POLICY].join(' '))\"",
          },
    ),
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
        id: "resp_repair_marker",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

describe("update repair with a local model provider", () => {
  it.each(["validating", "verifying"] as const)(
    "runs host exec on the pinned target during %s",
    async (phase) => {
      await withOpenClawTestState(
        { prefix: "update-repair-boundary-", layout: "home" },
        async (state) => {
          const requests: ModelRequest[] = [];
          const errors: unknown[] = [];
          let issuedRepair = false;
          let issuedScopeProbe = false;
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
                const body = JSON.parse(await readText(request)) as ModelRequest;
                requests.push(body);
                if (body.tools?.some((tool) => tool.name === "write") && !issuedScopeProbe) {
                  issuedScopeProbe = true;
                  writeRepairToolCall(response, "write");
                  return;
                }
                if (body.tools?.some((tool) => tool.name === "exec") && !issuedRepair) {
                  issuedRepair = true;
                  writeRepairToolCall(response, "exec");
                  return;
                }
                writeOpenAiResponsesText(response, {
                  text: issuedRepair
                    ? 'REPAIR_RESULT: {"status":"fixed","summary":"Created the target repair marker."}'
                    : "OK",
                  messageId: `msg_repair_${requests.length}`,
                  responseId: `resp_repair_${requests.length}`,
                });
              })().catch((error: unknown) => {
                errors.push(error);
                response.writeHead(500).end();
              });
            },
            async (baseUrl) => {
              const modelRef = "repair-test/repair-model";
              const config: OpenClawConfig = {
                plugins: { slots: { memory: "none" } },
                tools: { exec: { mode: "ask", safeBins: ["cat"] }, fs: { workspaceOnly: false } },
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
              await state.writeConfig(config);
              const marker = path.join(state.workspaceDir, "repair-proof.txt");
              const expected = `${state.stateDir} 0 0 external`;
              const ledgerEnv = { ...process.env };
              const run = createUpdateRun({ trigger: "cli" }, { env: ledgerEnv });
              recordUpdateRunPhase(run.runId, "repairing", undefined, { env: ledgerEnv });
              if (phase === "verifying") {
                await fs.symlink(
                  path.join(process.cwd(), "dist"),
                  path.join(state.workspaceDir, "dist"),
                  "dir",
                );
              }
              const result = await prepareUnattendedUpdateRepair({
                runId: run.runId,
                isCurrent: () => getUpdateRun(run.runId, { env: ledgerEnv })?.status === "running",
                target: {
                  stateDir: state.stateDir,
                  configPath: state.configPath,
                  workspaceDir: state.workspaceDir,
                  installRoot: state.workspaceDir,
                },
                context: { error: "Synthetic repair marker is missing.", phase },
                budget: { maxTurns: 1, wallClockMs: 90_000, perTurnMs: 60_000, maxToolCalls: 2 },
                validate: async () => {
                  const text = await fs.readFile(marker, "utf8").catch(() => "");
                  const ok = text === expected;
                  return {
                    ok,
                    score: ok ? 1 : 0,
                    summary: ok ? "Target marker verified." : "Target marker absent.",
                  };
                },
              });

              expect(errors).toEqual([]);
              expect(result, JSON.stringify(result)).toMatchObject({
                status: "repaired",
                finalValidation: { ok: true, score: 1 },
                attempts: [{ toolCalls: 2, summary: "Created the target repair marker." }],
              });
              expect(
                requests.some((body) => body.tools?.some((tool) => tool.name === "exec")),
              ).toBe(true);
              expect(issuedScopeProbe).toBe(true);
              await expect(
                fs.stat(path.join(state.workspaceDir, "..", "outside-repair.txt")),
              ).rejects.toMatchObject({ code: "ENOENT" });
              expect(await fs.readFile(marker, "utf8")).toBe(expected);
            },
          );
        },
      );
    },
    120_000,
  );
});
