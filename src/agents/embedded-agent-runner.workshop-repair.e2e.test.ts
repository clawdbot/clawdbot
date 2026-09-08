// Real foreground runner and tools; only the model's HTTP responses are scripted.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../gateway/test-openai-responses-model.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { inspectSkillProposal, listSkillProposals } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner/run.js";

type ProviderRequest = {
  input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
  tools?: Array<{ name?: string }>;
};

function respondWithTool(
  response: ServerResponse,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
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
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

describe("foreground Workshop repair compatibility", () => {
  it.each([
    ["default", "omitted", "applied"],
    ["off", "omitted", "disabled"],
    ["propose", "omitted", "pending"],
    ["auto", "omitted", "applied"],
    ["off", "auto", "disabled"],
    ["propose", "auto", "pending"],
    ["auto", "auto", "applied"],
    ["off", "pending", "disabled"],
    ["propose", "pending", "pending"],
    ["auto", "pending", "pending"],
  ] as const)(
    "mode=%s approval=%s: %s",
    { timeout: 60_000 },
    async (mode, approvalPolicy, status) => {
      const state = await createOpenClawTestState({
        label: "foreground-workshop-repair",
        layout: "home",
      });
      const requests: ProviderRequest[] = [];
      const providerErrors: unknown[] = [];
      const oldRule = "Check weather before outdoor recommendations.";
      const newRule = "Check weather and alerts before outdoor recommendations.";
      const originalSkill = `---\nname: weather-planner\ndescription: Plan around current weather\n---\n# Weather Planner\n\n${oldRule}\n`;
      try {
        await withServer(
          (request, response) => {
            void (async () => {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
              }
              const payload = JSON.parse(await readText(request)) as ProviderRequest;
              requests.push(payload);
              const skillFile = path.join(
                resolveWorkshopSkillsDir({}, "main"),
                "weather-planner",
                "SKILL.md",
              );
              const actions = [
                // The real read wrapper produces the run-usage receipt. Workshop read
                // separately authorizes the exact current content hash for patching.
                { name: "read", args: { path: skillFile } },
                { name: "skill_workshop", args: { action: "read", skill_name: "weather-planner" } },
                {
                  name: "skill_workshop",
                  args: {
                    action: "patch",
                    skill_name: "weather-planner",
                    old_string: oldRule,
                    new_string: newRule,
                  },
                },
                // Generic skill reads intentionally reuse the running snapshot;
                // Workshop read projects the current live artifact after patching.
                { name: "skill_workshop", args: { action: "read", skill_name: "weather-planner" } },
              ];
              const next = actions[requests.length - 1];
              if (next) {
                respondWithTool(response, `step_${requests.length}`, next.name, next.args);
              } else {
                writeOpenAiResponsesText(response, {
                  text: "Finished checking the repair result.",
                  messageId: "done",
                  responseId: "done",
                });
              }
            })().catch((error: unknown) => {
              providerErrors.push(error);
              response.writeHead(500).end(String(error));
            });
          },
          async (baseUrl) => {
            const provider = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`);
            const rawConfig: OpenClawConfig = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              models: {
                mode: "replace",
                providers: { [provider.providerId]: { ...provider.config, authHeader: false } },
              },
              plugins: { enabled: false, slots: { memory: "none" } },
              tools: { allow: ["read", "skill_workshop"] },
              ...(mode === "default"
                ? {}
                : {
                    skills: {
                      workshop: {
                        autonomous: { mode },
                        ...(approvalPolicy === "omitted" ? {} : { approvalPolicy }),
                      },
                    },
                  }),
            };
            // Exercise an on-disk configuration reload, including truly absent fields.
            await state.writeConfig(rawConfig);
            const config = loadConfig();
            expect(config.skills?.workshop?.approvalPolicy).toBe(
              approvalPolicy === "omitted" ? undefined : approvalPolicy,
            );
            const skillFile = path.join(
              resolveWorkshopSkillsDir(config, "main"),
              "weather-planner",
              "SKILL.md",
            );
            await fs.mkdir(state.workspaceDir, { recursive: true });
            await fs.mkdir(path.dirname(skillFile), { recursive: true });
            await fs.writeFile(skillFile, originalSkill);
            const runId = randomUUID();
            const sessionId = randomUUID();
            const admission = prepareSystemAgentRunAdmission(
              config,
              runId,
              "main",
              "foreground-workshop-proof",
            );
            try {
              const result = await runEmbeddedAgent({
                config,
                preparedRunAdmission: admission,
                sessionId,
                sessionKey: `agent:main:workshop-proof-${sessionId}`,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                runId,
                trigger: "user",
                skillsSnapshot: buildSkillSnapshot(state.workspaceDir, { config, agentId: "main" }),
                provider: provider.providerId,
                model: provider.modelId,
                agentHarnessRuntimeOverride: "openclaw",
                prompt:
                  "Use weather-planner for outdoor advice. Its weather-only rule is incomplete: include alerts. Read it, propose the targeted correction, and read the live result.",
                timeoutMs: 45_000,
              });
              expect(result.meta.error).toBeUndefined();
              expect(result.meta.aborted).not.toBe(true);
              expect(providerErrors).toEqual([]);
              expect(requests).toHaveLength(5);
              expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["read", "skill_workshop"]),
              );
              const output = (step: number) =>
                JSON.stringify(
                  requests[step]?.input?.findLast((item) => item.type === "function_call_output")
                    ?.output,
                );
              // Assert the provider received real post-patch tool output, not only a
              // test-side read or a scripted assistant claim about the outcome.
              expect(output(1)).toContain(oldRule);
              expect(output(2)).toContain(oldRule);
              const expectedRule = status === "applied" ? newRule : oldRule;
              expect(output(4)).toContain(expectedRule);
              expect(output(4)).not.toContain(status === "applied" ? oldRule : newRule);
              expect(output(3)).toContain(
                status === "disabled"
                  ? "disabled by autonomous mode off"
                  : status === "pending"
                    ? "pending"
                    : "Repaired used skill",
              );
              const persisted = await listSkillProposals({ config, agentId: "main" });
              expect(persisted.proposals).toHaveLength(status === "disabled" ? 0 : 1);
              if (status !== "disabled") {
                const proposal = await inspectSkillProposal(persisted.proposals[0]!.id, {
                  config,
                  agentId: "main",
                });
                expect(proposal?.record).toMatchObject({
                  status,
                  kind: "update",
                  origin: { runId },
                });
                expect(proposal?.content).toContain(newRule);
              }
              const liveSkill = await fs.readFile(skillFile, "utf8");
              if (status === "applied") {
                expect(liveSkill).toContain(newRule);
                expect(liveSkill).not.toContain(oldRule);
              } else {
                expect(liveSkill).toBe(originalSkill);
              }
              expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(rawConfig);
            } finally {
              admission.close();
            }
          },
        );
      } finally {
        await state.cleanup();
      }
    },
  );
});
