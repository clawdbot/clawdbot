#!/usr/bin/env -S node --import tsx
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import type { Model } from "../../packages/agent-core/src/llm.js";
import type { AgentEvent, AgentTool } from "../../packages/agent-core/src/types.js";
import {
  clearCodeModeNamespacesForPlugin,
  createCodeModeNamespaceTool,
  registerCodeModeNamespaceForPlugin,
} from "../../src/agents/code-mode-namespaces.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../../src/agents/code-mode.js";
import { Agent } from "../../src/agents/runtime/index.js";
import { createToolSearchCatalogRef } from "../../src/agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../../src/agents/tools/common.js";
import { setPluginToolMeta } from "../../src/plugins/tools.js";

type Mode = "regular" | "code-catalog" | "code-namespace";

type FictionTitle = {
  id: string;
  title: string;
  lead: string;
  status: string;
  riskScore: number;
  dependencies: Array<{ id: string; cleared: boolean }>;
};

type FictionScene = {
  id: string;
  titleId: string;
  pages: number;
  blocked: boolean;
};

type FictionDefect = {
  id: string;
  titleId: string;
  sceneId: string;
  state: "open" | "closed";
};

type FictionInvoice = {
  id: string;
  titleId: string;
  author: string;
  amount: number;
  paid: boolean;
};

type FictionServiceState = {
  titles: FictionTitle[];
  scenes: FictionScene[];
  defects: FictionDefect[];
  invoices: FictionInvoice[];
};

type FictionService = ReturnType<typeof createFictionService>;

type Task = {
  id: string;
  prompt: string;
  validate(answer: unknown, service: FictionService): { ok: boolean; reason?: string };
};

type RunMetrics = {
  mode: Mode;
  task: string;
  ok: boolean;
  reason?: string;
  latencyMs: number;
  modelTurns: number;
  assistantMessages: number;
  topLevelToolCalls: number;
  serviceCalls: number;
  finalText: string;
  stopReason?: string;
  errorMessage?: string;
  toolResults?: unknown[];
};

const PLUGIN_ID = "fictions-live";

function cloneState(): FictionServiceState {
  return {
    titles: [
      {
        id: "PX-73",
        title: "The Glass Orchard",
        lead: "Mira Vale",
        status: "draft",
        riskScore: 77,
        dependencies: [
          { id: "outline", cleared: true },
          { id: "rights", cleared: true },
        ],
      },
      {
        id: "NM-12",
        title: "Night Market of Moons",
        lead: "Oren Quill",
        status: "revision",
        riskScore: 91,
        dependencies: [
          { id: "continuity", cleared: true },
          { id: "copyedit", cleared: false },
        ],
      },
      {
        id: "RS-40",
        title: "River Static",
        lead: "Nia Rowan",
        status: "locked",
        riskScore: 54,
        dependencies: [{ id: "legal", cleared: true }],
      },
    ],
    scenes: [
      { id: "PX-73-S1", titleId: "PX-73", pages: 32, blocked: false },
      { id: "PX-73-S2", titleId: "PX-73", pages: 28, blocked: false },
      { id: "PX-73-S3", titleId: "PX-73", pages: 36, blocked: false },
      { id: "NM-12-S1", titleId: "NM-12", pages: 44, blocked: false },
      { id: "NM-12-S2", titleId: "NM-12", pages: 39, blocked: true },
      { id: "RS-40-S1", titleId: "RS-40", pages: 51, blocked: false },
    ],
    defects: [
      { id: "D-101", titleId: "NM-12", sceneId: "NM-12-S1", state: "open" },
      { id: "D-102", titleId: "NM-12", sceneId: "NM-12-S2", state: "open" },
      { id: "D-103", titleId: "NM-12", sceneId: "NM-12-S2", state: "open" },
      { id: "D-104", titleId: "PX-73", sceneId: "PX-73-S3", state: "closed" },
      { id: "D-105", titleId: "RS-40", sceneId: "RS-40-S1", state: "open" },
    ],
    invoices: [
      { id: "I-200", titleId: "PX-73", author: "Mira Vale", amount: 4200, paid: false },
      { id: "I-201", titleId: "NM-12", author: "Oren Quill", amount: 6100, paid: false },
      { id: "I-202", titleId: "RS-40", author: "Nia Rowan", amount: 3700, paid: true },
    ],
  };
}

function createFictionService() {
  const state = cloneState();
  let calls = 0;
  const note = () => {
    calls += 1;
  };
  const title = (id: string) => state.titles.find((entry) => entry.id === id);
  return {
    get calls() {
      return calls;
    },
    snapshot() {
      note();
      return structuredClone(state);
    },
    listTitles() {
      note();
      return structuredClone(state.titles);
    },
    getTitle(id: string) {
      note();
      return title(id) ?? null;
    },
    listScenes(titleId?: string) {
      note();
      return structuredClone(state.scenes.filter((entry) => !titleId || entry.titleId === titleId));
    },
    listDefects(titleId?: string) {
      note();
      return state.defects
        .filter((entry) => !titleId || entry.titleId === titleId)
        .map((entry) => structuredClone(entry));
    },
    listInvoices(author?: string) {
      note();
      return structuredClone(state.invoices.filter((entry) => !author || entry.author === author));
    },
    updateStatus(id: string, status: string) {
      note();
      const entry = title(id);
      if (!entry) {
        return { ok: false, error: "unknown title", id };
      }
      entry.status = status;
      return { ok: true, id, status };
    },
    currentStatus(id: string) {
      return title(id)?.status;
    },
  };
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function makeTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  execute: (params: Record<string, unknown>) => unknown,
): AnyAgentTool {
  const tool = {
    name,
    label: name,
    description,
    parameters: Type.Object(properties),
    execute: async (_toolCallId: string, params: unknown) =>
      jsonResult(
        execute((params && typeof params === "object" ? params : {}) as Record<string, unknown>),
      ),
  } satisfies AnyAgentTool;
  setPluginToolMeta(tool, { pluginId: PLUGIN_ID, optional: true });
  return tool;
}

function createFictionTools(service: FictionService): AnyAgentTool[] {
  return [
    makeTool("fictions_list_titles", "List fiction titles with status and risk.", {}, () =>
      service.listTitles(),
    ),
    makeTool(
      "fictions_get_title",
      "Get one fiction title by id.",
      { id: Type.String() },
      (params) => service.getTitle(stringParam(params, "id")),
    ),
    makeTool(
      "fictions_list_scenes",
      "List scenes, optionally filtered by title id.",
      { titleId: Type.Optional(Type.String()) },
      (params) =>
        service.listScenes(typeof params.titleId === "string" ? params.titleId : undefined),
    ),
    makeTool(
      "fictions_list_defects",
      "List defects, optionally filtered by title id.",
      { titleId: Type.Optional(Type.String()) },
      (params) =>
        service.listDefects(typeof params.titleId === "string" ? params.titleId : undefined),
    ),
    makeTool(
      "fictions_list_invoices",
      "List invoices, optionally filtered by author.",
      { author: Type.Optional(Type.String()) },
      (params) =>
        service.listInvoices(typeof params.author === "string" ? params.author : undefined),
    ),
    makeTool(
      "fictions_update_status",
      "Update a fiction title status.",
      { id: Type.String(), status: Type.String() },
      (params) => service.updateStatus(stringParam(params, "id"), stringParam(params, "status")),
    ),
  ];
}

function createFictionNamespaceTools(service: FictionService): AnyAgentTool[] {
  return [
    makeTool("fictions_snapshot", "Return the complete fiction production snapshot.", {}, () =>
      service.snapshot(),
    ),
    makeTool("fictions_risk_audit", "Return highest-risk title audit.", {}, () => {
      const data = service.snapshot();
      const highest = data.titles.toSorted((a, b) => b.riskScore - a.riskScore)[0];
      if (!highest) {
        return null;
      }
      return {
        task: "risk-audit",
        id: highest.id,
        lead: highest.lead,
        status: highest.status,
        unresolvedDefects: data.defects.filter(
          (defect) => defect.titleId === highest.id && defect.state === "open",
        ).length,
        blockedScenes: data.scenes
          .filter((scene) => scene.titleId === highest.id && scene.blocked)
          .map((scene) => scene.id),
      };
    }),
    makeTool(
      "fictions_promote_if_ready",
      "Promote a title if dependencies and page count allow it.",
      { id: Type.String(), status: Type.String() },
      (params) => {
        const id = stringParam(params, "id");
        const status = stringParam(params, "status");
        const data = service.snapshot();
        const title = data.titles.find((entry) => entry.id === id);
        const scenes = data.scenes.filter((scene) => scene.titleId === id);
        const totalPages = scenes.reduce((sum, scene) => sum + scene.pages, 0);
        const dependenciesCleared =
          title?.dependencies.every((dependency) => dependency.cleared) ?? false;
        if (!title || totalPages >= 110 || !dependenciesCleared) {
          return {
            task: "promote",
            id,
            action: "blocked",
            totalPages,
            finalStatus: title?.status ?? null,
          };
        }
        const updated = service.updateStatus(id, status);
        return {
          task: "promote",
          id,
          action: updated.ok ? "updated" : "blocked",
          totalPages,
          finalStatus: service.currentStatus(id) ?? null,
        };
      },
    ),
    makeTool(
      "fictions_unpaid_over",
      "Return unpaid invoices over a numeric threshold.",
      { amount: Type.Number() },
      (params) => {
        const amount = typeof params.amount === "number" ? params.amount : 0;
        const data = service.snapshot();
        const invoices = data.invoices.filter(
          (invoice) => !invoice.paid && invoice.amount > amount,
        );
        return {
          task: "invoice",
          invoiceIds: invoices.map((invoice) => invoice.id),
          totalUnpaidOver5000: invoices.reduce((sum, invoice) => sum + invoice.amount, 0),
        };
      },
    ),
  ];
}

function registerFictionNamespace(): void {
  clearCodeModeNamespacesForPlugin(PLUGIN_ID);
  registerCodeModeNamespaceForPlugin(PLUGIN_ID, {
    id: "fictions",
    globalName: "Fictions",
    description: "Fiction production service helpers.",
    requiredToolNames: [
      "fictions_promote_if_ready",
      "fictions_risk_audit",
      "fictions_snapshot",
      "fictions_unpaid_over",
    ],
    prompt:
      "Use Fictions.riskAudit(), Fictions.promoteIfReady(id, status), Fictions.unpaidOver(amount), and Fictions.snapshot().",
    createScope: () => ({
      snapshot: createCodeModeNamespaceTool("fictions_snapshot"),
      riskAudit: createCodeModeNamespaceTool("fictions_risk_audit"),
      promoteIfReady: createCodeModeNamespaceTool("fictions_promote_if_ready", ([id, status]) => ({
        id: typeof id === "string" ? id : "",
        status: typeof status === "string" ? status : "",
      })),
      unpaidOver: createCodeModeNamespaceTool("fictions_unpaid_over", ([amount]) => ({
        amount: typeof amount === "number" ? amount : 0,
      })),
    }),
  });
}

function createModel(modelId: string): Model<"openai-responses"> {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: modelId.startsWith("gpt-5"),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  };
}

function systemPromptForMode(mode: Mode): string {
  const base =
    "You are testing a fiction production service. Use the available tools, never invent data, and return only one minified JSON object. No markdown.";
  if (mode === "regular") {
    return `${base} Use the Fictions tools directly.`;
  }
  if (mode === "code-catalog") {
    return `${base} Use code_mode_exec with JavaScript and always return the final JSON object from the code. In code, call direct tool helpers such as await tools.fictions_list_titles({}), await tools.fictions_list_scenes({titleId:"PX-73"}), await tools.fictions_list_defects({titleId:"NM-12"}), await tools.fictions_list_invoices({}), and await tools.fictions_update_status({id:"PX-73",status:"preproduction"}). Call code_mode_wait until the code result is completed, then return that completed value as your final answer.`;
  }
  return `${base} Use code_mode_exec with JavaScript and always return the final JSON object from the code. In code, prefer the namespace helpers: return await Fictions.riskAudit(); return await Fictions.promoteIfReady("PX-73","preproduction"); return await Fictions.unpaidOver(5000). Call code_mode_wait until the code result is completed, then return that completed value as your final answer.`;
}

function toolsForMode(mode: Mode, service: FictionService): AgentTool[] {
  const fictionTools = createFictionTools(service);
  if (mode === "regular") {
    return fictionTools as AgentTool[];
  }
  if (mode === "code-namespace") {
    registerFictionNamespace();
  } else {
    clearCodeModeNamespacesForPlugin(PLUGIN_ID);
  }
  const config = {
    tools: {
      codeMode: {
        enabled: true,
        timeoutMs: 20_000,
        maxPendingToolCalls: 32,
      },
    },
  };
  const catalogRef = createToolSearchCatalogRef();
  const codeModeTools = createCodeModeTools({
    config,
    runtimeConfig: config,
    sessionId: `live-${mode}`,
    sessionKey: `agent:live-${mode}:main`,
    agentId: "live",
    runId: `run-${mode}`,
    catalogRef,
  });
  const catalogTools =
    mode === "code-namespace" ? createFictionNamespaceTools(service) : fictionTools;
  return applyCodeModeCatalog({
    tools: [...codeModeTools, ...catalogTools],
    config,
    sessionId: `live-${mode}`,
    sessionKey: `agent:live-${mode}:main`,
    agentId: "live",
    runId: `run-${mode}`,
    catalogRef,
  }).tools as AgentTool[];
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
    )
    .map((entry) => (entry as { text?: string }).text ?? "")
    .join("");
}

function parseFirstJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    }
    throw new Error("assistant did not return JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const tasks: Task[] = [
  {
    id: "risk-audit",
    prompt:
      'Find the fiction title with the highest riskScore. Return JSON with keys task, id, lead, status, unresolvedDefects, blockedScenes. blockedScenes must be an array of blocked scene ids, not a count. task must be "risk-audit".',
    validate(answer) {
      if (!isRecord(answer)) {
        return { ok: false, reason: "answer is not an object" };
      }
      const blockedScenes = Array.isArray(answer.blockedScenes)
        ? answer.blockedScenes.map(String).toSorted()
        : [];
      const unresolvedDefects = Array.isArray(answer.unresolvedDefects)
        ? answer.unresolvedDefects.length
        : answer.unresolvedDefects;
      const ok =
        answer.task === "risk-audit" &&
        answer.id === "NM-12" &&
        answer.lead === "Oren Quill" &&
        answer.status === "revision" &&
        unresolvedDefects === 3 &&
        JSON.stringify(blockedScenes) === JSON.stringify(["NM-12-S2"]);
      return ok ? { ok } : { ok, reason: `unexpected risk audit: ${JSON.stringify(answer)}` };
    },
  },
  {
    id: "promote",
    prompt:
      'For PX-73, if total scene pages are below 110 and every dependency is cleared, update its status to "preproduction". If a Fictions.promoteIfReady helper exists, use it. Return JSON with keys task, id, action, totalPages, finalStatus. action must be exactly "updated" when the command succeeds. task must be "promote".',
    validate(answer, service) {
      if (!isRecord(answer)) {
        return { ok: false, reason: "answer is not an object" };
      }
      const ok =
        answer.task === "promote" &&
        answer.id === "PX-73" &&
        typeof answer.action === "string" &&
        answer.action.includes("updated") &&
        answer.totalPages === 96 &&
        answer.finalStatus === "preproduction" &&
        service.currentStatus("PX-73") === "preproduction";
      return ok ? { ok } : { ok, reason: `unexpected promote result: ${JSON.stringify(answer)}` };
    },
  },
  {
    id: "invoice",
    prompt:
      'For unpaid invoices over 5000, return JSON with keys task, invoiceIds, totalUnpaidOver5000. task must be "invoice".',
    validate(answer) {
      if (!isRecord(answer)) {
        return { ok: false, reason: "answer is not an object" };
      }
      const invoiceIds = Array.isArray(answer.invoiceIds)
        ? answer.invoiceIds.map(String).toSorted()
        : [];
      const ok =
        answer.task === "invoice" &&
        JSON.stringify(invoiceIds) === JSON.stringify(["I-201"]) &&
        answer.totalUnpaidOver5000 === 6100;
      return ok ? { ok } : { ok, reason: `unexpected invoice result: ${JSON.stringify(answer)}` };
    },
  },
];

async function runOne(mode: Mode, task: Task, model: string, apiKey: string): Promise<RunMetrics> {
  const service = createFictionService();
  const counts = {
    modelTurns: 0,
    assistantMessages: 0,
    topLevelToolCalls: 0,
  };
  const toolResults: unknown[] = [];
  const agent = new Agent({
    sessionId: `code-mode-live-${mode}-${task.id}`,
    initialState: {
      model: createModel(model),
      systemPrompt: systemPromptForMode(mode),
      tools: toolsForMode(mode, service),
      thinkingLevel: "off",
    },
    getApiKey: (provider) => (provider === "openai" ? apiKey : undefined),
    toolExecution: "parallel",
    maxRetryDelayMs: 10_000,
  });
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_start") {
      counts.modelTurns += 1;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      counts.assistantMessages += 1;
    } else if (event.type === "tool_execution_start") {
      counts.topLevelToolCalls += 1;
    } else if (event.type === "tool_execution_end") {
      toolResults.push(event.result);
    }
  });

  const started = performance.now();
  await agent.prompt(task.prompt);
  const latencyMs = Math.round(performance.now() - started);
  const lastAssistant = agent.state.messages
    .toReversed()
    .find((message) => message.role === "assistant");
  const finalText = textFromMessageContent(lastAssistant?.content).trim();
  let validation: { ok: boolean; reason?: string };
  try {
    validation = task.validate(parseFirstJson(finalText), service);
  } catch (error) {
    validation = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    mode,
    task: task.id,
    ok: validation.ok,
    ...(validation.reason ? { reason: validation.reason } : {}),
    latencyMs,
    modelTurns: counts.modelTurns,
    assistantMessages: counts.assistantMessages,
    topLevelToolCalls: counts.topLevelToolCalls,
    serviceCalls: service.calls,
    finalText,
    ...(lastAssistant?.stopReason ? { stopReason: lastAssistant.stopReason } : {}),
    ...(lastAssistant?.errorMessage ? { errorMessage: lastAssistant.errorMessage } : {}),
    ...(process.env.OPENCLAW_CODE_MODE_LIVE_DEBUG === "1" ? { toolResults } : {}),
  };
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const model = readArg("model") ?? process.env.OPENCLAW_CODE_MODE_LIVE_MODEL ?? "gpt-5.4-mini";
  const modeArg = readArg("modes");
  const modes = (modeArg ? modeArg.split(",") : ["regular", "code-namespace"]) as Mode[];
  const taskLimit = Number(readArg("tasks") ?? process.env.OPENCLAW_CODE_MODE_LIVE_TASKS ?? "3");
  const selectedTasks = tasks.slice(
    0,
    Number.isFinite(taskLimit) && taskLimit > 0 ? taskLimit : tasks.length,
  );
  const results: RunMetrics[] = [];
  for (const task of selectedTasks) {
    for (const mode of modes) {
      results.push(await runOne(mode, task, model, apiKey));
    }
  }
  const summary = {
    model,
    tasks: selectedTasks.map((task) => task.id),
    results,
    aggregate: modes.map((mode) => {
      const entries = results.filter((entry) => entry.mode === mode);
      return {
        mode,
        ok: entries.filter((entry) => entry.ok).length,
        total: entries.length,
        latencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0),
        modelTurns: entries.reduce((sum, entry) => sum + entry.modelTurns, 0),
        topLevelToolCalls: entries.reduce((sum, entry) => sum + entry.topLevelToolCalls, 0),
        serviceCalls: entries.reduce((sum, entry) => sum + entry.serviceCalls, 0),
      };
    }),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (results.some((entry) => !entry.ok)) {
    process.exitCode = 1;
  }
}

await main().finally(() => {
  clearCodeModeNamespacesForPlugin(PLUGIN_ID);
});
