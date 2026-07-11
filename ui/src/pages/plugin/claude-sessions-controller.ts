import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  bindCodexTranscript,
  configureCodexSessionsPolling,
  getCodexSessionsState,
  loadCodexSessions,
  loadCodexTranscript,
  loadMoreCodexSessions,
  setCodexSessionsSearch,
  stopCodexSessionsPolling,
  unbindCodexTranscript,
  type CodexSessionsUiState,
} from "./codex-sessions-controller.ts";

const hosts = new WeakMap<object, object>();
const clients = new WeakMap<GatewayBrowserClient, GatewayBrowserClient>();

function controllerHost(host: object): object {
  let isolated = hosts.get(host);
  if (!isolated) {
    isolated = {};
    hosts.set(host, isolated);
  }
  return isolated;
}

function claudeClient(client: GatewayBrowserClient | null): GatewayBrowserClient | null {
  if (!client) {
    return null;
  }
  let adapter = clients.get(client);
  if (!adapter) {
    adapter = new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "request") {
          return Reflect.get(target, property, receiver);
        }
        return <T>(method: string, params?: unknown) => {
          const mapped =
            method === "codex.sessions.list"
              ? "anthropic.sessions.list"
              : method === "codex.sessions.read"
                ? "anthropic.sessions.read"
                : method;
          return target.request<T>(mapped, params);
        };
      },
    });
    clients.set(client, adapter);
  }
  return adapter;
}

export function getClaudeSessionsState(host: object): CodexSessionsUiState {
  return getCodexSessionsState(controllerHost(host));
}

export async function loadClaudeSessions(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
): Promise<void> {
  await loadCodexSessions(state, claudeClient(client));
}

export async function loadMoreClaudeSessions(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
): Promise<void> {
  await loadMoreCodexSessions(state, claudeClient(client), hostId);
}

export function setClaudeSessionsSearch(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  search: string,
): void {
  setCodexSessionsSearch(state, claudeClient(client), search);
}

export function bindClaudeTranscript(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
  threadId: string,
): void {
  bindCodexTranscript(state, claudeClient(client), hostId, threadId);
}

export async function loadClaudeTranscript(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  hostId: string,
  threadId: string,
  options: { append?: boolean } = {},
): Promise<void> {
  await loadCodexTranscript(state, claudeClient(client), hostId, threadId, options);
}

export function unbindClaudeTranscript(state: CodexSessionsUiState): void {
  unbindCodexTranscript(state);
}

export function configureClaudeSessionsPolling(
  state: CodexSessionsUiState,
  client: GatewayBrowserClient | null,
  active: boolean,
): void {
  configureCodexSessionsPolling(state, claudeClient(client), active);
}

export function stopClaudeSessionsPolling(host: object): void {
  stopCodexSessionsPolling(controllerHost(host));
}
