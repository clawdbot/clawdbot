// Control UI controller manages agent files gateway state.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentFileEntry,
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
} from "../../api/types.ts";

type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
};

function mergeFileEntry(
  list: AgentsFilesListResult | null,
  entry: AgentFileEntry,
): AgentsFilesListResult | null {
  if (!list) {
    return list;
  }
  const hasEntry = list.files.some((file) => file.name === entry.name);
  const nextFiles = hasEntry
    ? list.files.map((file) => (file.name === entry.name ? entry : file))
    : [...list.files, entry];
  return { ...list, files: nextFiles };
}

export async function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean; preserveDraft?: boolean },
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.agentFilesLoading) {
    return false;
  }
  if (!opts?.force && Object.hasOwn(state.agentFileContents, name)) {
    return true;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await client.request<AgentsFilesGetResult | null>("agents.files.get", {
      agentId,
      name,
    });
    if (res?.file && isCurrent()) {
      const content = res.file.content ?? "";
      const previousBase = state.agentFileContents[name] ?? "";
      const currentDraft = state.agentFileDrafts[name];
      const preserveDraft = opts?.preserveDraft ?? true;
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      if (
        !preserveDraft ||
        !Object.hasOwn(state.agentFileDrafts, name) ||
        currentDraft === previousBase
      ) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
      return true;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFilesError = String(err);
    }
    return false;
  } finally {
    if (isCurrent()) {
      state.agentFilesLoading = false;
    }
  }
  return false;
}

export async function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
) {
  const client = state.client;
  if (!client || !state.connected || state.agentFileSaving) {
    return;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentFileSaving = true;
  state.agentFilesError = null;
  try {
    const res = await client.request<AgentsFilesSetResult | null>("agents.files.set", {
      agentId,
      name,
      content,
    });
    if (res?.file && isCurrent()) {
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      // The response establishes the saved base, but must not discard text
      // entered after this save started.
      if (!Object.hasOwn(state.agentFileDrafts, name) || state.agentFileDrafts[name] === content) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentFilesError = String(err);
    }
  } finally {
    if (isCurrent()) {
      state.agentFileSaving = false;
    }
  }
}
