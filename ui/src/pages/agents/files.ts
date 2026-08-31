// Control UI controller manages agent files gateway state.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesGetResult, AgentsFilesSetResult } from "../../api/types.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agents: Pick<AgentCapability, "recordFile">;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  agentFileWriteRevisions: Map<string, number>;
};

async function requestAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  operation: { kind: "read"; force?: boolean } | { kind: "write"; content: string },
): Promise<boolean> {
  const saving = operation.kind === "write";
  const busy = saving ? "agentFileSaving" : "agentFilesLoading";
  const client = state.client;
  const agents = state.agents;
  if (!client || !state.connected || state[busy]) {
    return false;
  }
  if (
    operation.kind === "read" &&
    !operation.force &&
    Object.hasOwn(state.agentFileContents, name)
  ) {
    return true;
  }
  const generation = state.requestGeneration;
  const isConnected = () =>
    state.client === client &&
    state.agents === agents &&
    state.connected &&
    state.requestGeneration === generation;
  const advanceWriteRevision = () => {
    state.agentFileWriteRevisions.set(name, (state.agentFileWriteRevisions.get(name) ?? 0) + 1);
  };
  // Retire reads admitted before a write, and again on settlement for reads
  // admitted during it: a later read request can still return pre-write bytes.
  if (saving) {
    advanceWriteRevision();
  }
  const revision = state.agentFileWriteRevisions.get(name);
  const isCurrent = () =>
    isConnected() && (saving || state.agentFileWriteRevisions.get(name) === revision);
  state[busy] = true;
  state.agentFilesError = null;
  try {
    const res = await client.request<AgentsFilesGetResult | AgentsFilesSetResult | null>(
      saving ? "agents.files.set" : "agents.files.get",
      { agentId, name, ...(operation.kind === "write" ? { content: operation.content } : {}) },
    );
    if (res?.file && isCurrent()) {
      const content = operation.kind === "write" ? operation.content : (res.file.content ?? "");
      const previousBase = state.agentFileContents[name] ?? "";
      const currentDraft = state.agentFileDrafts[name];
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      // Reads rebase clean drafts; writes preserve edits made after submission.
      if (
        !Object.hasOwn(state.agentFileDrafts, name) ||
        currentDraft === (saving ? content : previousBase)
      ) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
      state.agentFilesError = null;
      agents.recordFile(res);
      return true;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFilesError = formatUiError(err);
    }
    return false;
  } finally {
    if (isConnected()) {
      if (saving) {
        advanceWriteRevision();
      }
      state[busy] = false;
    }
  }
  return false;
}

export function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "read", force: opts?.force });
}

export function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<boolean> {
  return requestAgentFile(state, agentId, name, { kind: "write", content });
}
