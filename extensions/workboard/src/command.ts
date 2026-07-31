import {
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardStatus,
} from "@openclaw/workboard-contract";
// Workboard plugin module implements command behavior.
import type { OpenClawPluginApi } from "../api.js";
import { resolveWorkboardCardByIdOrPrefix } from "./card-lookup.js";
import {
  dispatchAndStartWorkboardCards,
  type WorkboardSubagentRuntime,
  type WorkboardWorktreeRuntime,
} from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import {
  canonicalizeWorkboardWorkspaceAccess,
  resolveAgentWorkboardWorkspaceRuntime,
  resolveCommandWorkboardWorkspaceAccess,
  resolveWorkboardAgentWorkspace,
  type WorkboardTargetWorkspaceRuntime,
  type WorkboardWorkspaceAccess,
} from "./workspace-access.js";

const ADMIN_SCOPE = "operator.admin";
const WRITE_SCOPE = "operator.write";

type WorkboardCommandApi = {
  runtime: {
    subagent: WorkboardSubagentRuntime;
    worktrees: WorkboardWorktreeRuntime;
  };
};

function splitArgs(input: string | undefined): string[] {
  return (input ?? "").trim().split(/\s+/).filter(Boolean);
}

function formatCardLine(card: WorkboardCard): string {
  const boardId = card.metadata?.automation?.boardId ?? "default";
  const agent = card.agentId ? ` @${card.agentId}` : "";
  return `${card.id.slice(0, 8)} ${card.status.padEnd(8)} ${card.priority.padEnd(6)} [${boardId}]${agent} ${card.title}`;
}

function formatCardDetails(card: WorkboardCard): string {
  const lines = [
    card.title,
    `id: ${card.id}`,
    `status: ${card.status}`,
    `priority: ${card.priority}`,
    `board: ${card.metadata?.automation?.boardId ?? "default"}`,
  ];
  if (card.agentId) {
    lines.push(`agent: ${card.agentId}`);
  }
  if (card.sessionKey) {
    lines.push(`session: ${card.sessionKey}`);
  }
  if (card.runId) {
    lines.push(`run: ${card.runId}`);
  }
  if (card.notes) {
    lines.push("", card.notes);
  }
  return lines.join("\n");
}

function normalizeTitle(tokens: string[]): string {
  return tokens.join(" ").trim();
}

function isWorkboardStatus(value: string): value is WorkboardStatus {
  return (WORKBOARD_STATUSES as readonly string[]).includes(value);
}

function canMutateWorkboard(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  const scopes = params.gatewayClientScopes;
  if (scopes) {
    return scopes.includes(ADMIN_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return params.senderIsOwner === true;
}

function requireWriteAccess(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): { text: string; isError: true } | undefined {
  if (canMutateWorkboard(params)) {
    return undefined;
  }
  return {
    text: `This command requires gateway scope: ${WRITE_SCOPE}.`,
    isError: true,
  };
}

async function handleWorkboardCommand(params: {
  api: WorkboardCommandApi;
  store: WorkboardStore;
  args?: string;
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
  resolveAgentWorkspace?: (agentId?: string) => string;
  resolveAgentWorkspaceRuntime?: (
    agentId: string | undefined,
    sessionKey: string,
    workspaceDir: string,
    modelProvider?: string,
    modelId?: string,
  ) => WorkboardTargetWorkspaceRuntime | Promise<WorkboardTargetWorkspaceRuntime>;
  workspaceAccess?: WorkboardWorkspaceAccess;
}): Promise<{ text: string; isError?: boolean }> {
  const [action = "list", ...rest] = splitArgs(params.args);
  if (action === "help") {
    return {
      text: [
        "/workboard list",
        "/workboard show <card-id>",
        "/workboard create <title>",
        "/workboard move <card-id> --status <status>",
        "/workboard dispatch",
      ].join("\n"),
    };
  }
  if (action === "list") {
    const cards = (await params.store.list()).filter((card) => !card.metadata?.archivedAt);
    const rows = cards.slice(0, 12).map(formatCardLine);
    return { text: rows.length ? rows.join("\n") : "No Workboard cards." };
  }
  if (action === "show" || action === "read") {
    const id = rest[0];
    if (!id) {
      return { text: "Usage: /workboard show <card-id>", isError: true };
    }
    const cards = await params.store.list();
    const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
    return card ? { text: formatCardDetails(card) } : { text: error, isError: true };
  }
  if (action === "create") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const title = normalizeTitle(rest);
    if (!title) {
      return { text: "Usage: /workboard create <title>", isError: true };
    }
    const workspaceAccess = await canonicalizeWorkboardWorkspaceAccess(
      params.workspaceAccess ?? { unrestricted: true },
    );
    const card = await params.store.create({ title, workspaceAccess });
    return { text: `Created ${card.id.slice(0, 8)} ${card.title}` };
  }
  if (action === "move") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const id = rest[0];
    const statusIndex = rest.indexOf("--status");
    const status = statusIndex >= 0 ? rest[statusIndex + 1] : undefined;
    if (!id || !status) {
      return {
        text: "Usage: /workboard move <card-id> --status <status>",
        isError: true,
      };
    }
    if (!isWorkboardStatus(status)) {
      return {
        text: `status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`,
        isError: true,
      };
    }
    const cards = await params.store.list();
    const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
    if (!card) {
      return { text: error, isError: true };
    }
    return { text: formatCardLine(await params.store.move(card.id, status, undefined)) };
  }
  if (action === "dispatch") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const workspaceAccess = params.workspaceAccess ?? { unrestricted: true };
    const result = await dispatchAndStartWorkboardCards({
      store: params.store,
      subagent: params.api.runtime.subagent,
      worktrees: params.api.runtime.worktrees,
      options: {
        materializeWorktree: true,
        resolveAgentWorkspace: params.resolveAgentWorkspace,
        resolveAgentWorkspaceRuntime: params.resolveAgentWorkspaceRuntime,
        workspaceAccess,
      },
    });
    return {
      text: [
        `dispatch: started=${result.started.length} failures=${result.startFailures.length} promoted=${result.promoted.length} blocked=${result.blocked.length}`,
        ...result.started.map((run) => `started ${run.cardId.slice(0, 8)} run=${run.runId}`),
        ...result.startFailures.map(
          (failure) => `failed ${failure.cardId.slice(0, 8)} ${failure.error}`,
        ),
      ].join("\n"),
    };
  }
  return { text: `Unknown Workboard action: ${action}`, isError: true };
}

export function registerWorkboardCommand(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}): void {
  params.api.registerCommand({
    name: "workboard",
    description: "List, create, inspect, and dispatch Workboard cards.",
    acceptsArgs: true,
    exposeSenderIsOwner: true,
    handler: async (ctx) =>
      await handleWorkboardCommand({
        api: params.api,
        store: params.store,
        args: ctx.args,
        senderIsOwner: ctx.senderIsOwner,
        gatewayClientScopes: ctx.gatewayClientScopes,
        resolveAgentWorkspace: (agentId) => resolveWorkboardAgentWorkspace(ctx.config, agentId),
        resolveAgentWorkspaceRuntime: (agentId, sessionKey, workspaceDir, modelProvider, modelId) =>
          resolveAgentWorkboardWorkspaceRuntime({
            config: ctx.config,
            agentId,
            sessionKey,
            workspaceDir,
            modelProvider,
            modelId,
            prepareSandboxWorkspaceAuthority: params.api.runtime.sandbox.prepareWorkspaceAuthority,
          }),
        workspaceAccess: resolveCommandWorkboardWorkspaceAccess({
          config: ctx.config,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          gatewayClientScopes: ctx.gatewayClientScopes,
          resolveSandboxWorkspaceAuthority: params.api.runtime.sandbox.resolveWorkspaceAuthority,
        }),
      }),
  });
}
