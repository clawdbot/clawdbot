// Slack plugin module owns durable Agent View mode state.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";

const SLACK_AGENT_VIEW_STATE_NAMESPACE = "agent-view-workspaces";
const SLACK_AGENT_VIEW_THREAD_STATE_NAMESPACE = "agent-view-threads";
const SLACK_AGENT_VIEW_STATE_MAX_ENTRIES = 4096;
const SLACK_AGENT_VIEW_THREAD_STATE_MAX_ENTRIES = 4096;
const SLACK_MANAGED_THREAD_CACHE_MAX_ENTRIES = 4096;

type StoredSlackAgentViewState = {
  experience: "agent";
  observedAt: number;
};

type StoredSlackManagedThreadState = {
  experience: "managed-thread";
  observedAt: number;
};

export function createSlackAgentViewState(params: {
  accountId: string;
  teamId: string;
  apiAppId: string;
  warn: (action: string, error: unknown) => void;
}) {
  let enabled = false;
  let loaded = false;
  let persisted = false;
  let workspaceStore: PluginStateKeyedStore<StoredSlackAgentViewState> | undefined;
  let threadStore: PluginStateKeyedStore<StoredSlackManagedThreadState> | undefined;
  let warned = false;
  const managedThreads = new Map<string, true>();

  const warnOnce = (action: string, error: unknown) => {
    if (warned) {
      return;
    }
    warned = true;
    params.warn(action, error);
  };

  const openWorkspaceStore = () => {
    if (workspaceStore) {
      return workspaceStore;
    }
    const runtime = getOptionalSlackRuntime();
    if (!runtime) {
      return undefined;
    }
    try {
      // Slack cannot switch an app back to Assistant View, so this marker has no TTL.
      workspaceStore = runtime.state.openKeyedStore<StoredSlackAgentViewState>({
        namespace: SLACK_AGENT_VIEW_STATE_NAMESPACE,
        maxEntries: SLACK_AGENT_VIEW_STATE_MAX_ENTRIES,
      });
      return workspaceStore;
    } catch (error) {
      warnOnce("open", error);
      return undefined;
    }
  };

  const openThreadStore = () => {
    if (threadStore) {
      return threadStore;
    }
    const runtime = getOptionalSlackRuntime();
    if (!runtime) {
      return undefined;
    }
    try {
      threadStore = runtime.state.openKeyedStore<StoredSlackManagedThreadState>({
        namespace: SLACK_AGENT_VIEW_THREAD_STATE_NAMESPACE,
        maxEntries: SLACK_AGENT_VIEW_THREAD_STATE_MAX_ENTRIES,
      });
      return threadStore;
    } catch (error) {
      warnOnce("open", error);
      return undefined;
    }
  };

  const workspaceStateKey = params.apiAppId
    ? JSON.stringify(["workspace", params.accountId, params.teamId, params.apiAppId])
    : undefined;
  const record = async () => {
    enabled = true;
    loaded = true;
    if (persisted || !workspaceStateKey) {
      return;
    }
    const openedStore = openWorkspaceStore();
    if (!openedStore) {
      return;
    }
    try {
      await openedStore.register(workspaceStateKey, {
        experience: "agent",
        observedAt: Date.now(),
      });
      persisted = true;
    } catch (error) {
      warnOnce("persist", error);
    }
  };

  const isEnabled = async () => {
    if (enabled) {
      return true;
    }
    if (loaded) {
      return false;
    }
    if (!workspaceStateKey) {
      loaded = true;
      return false;
    }
    const openedStore = openWorkspaceStore();
    if (!openedStore) {
      return false;
    }
    try {
      const stored = await openedStore.lookup(workspaceStateKey);
      loaded = true;
      enabled = stored?.experience === "agent";
      persisted = enabled;
      return enabled;
    } catch (error) {
      warnOnce("load", error);
      return false;
    }
  };

  const managedThreadKey = (channelId: string, threadTs: string) =>
    JSON.stringify([channelId, threadTs]);
  const managedThreadStateKey = (channelId: string, threadTs: string) =>
    params.apiAppId
      ? JSON.stringify([
          "thread",
          params.accountId,
          params.teamId,
          params.apiAppId,
          channelId,
          threadTs,
        ])
      : undefined;
  const rememberManagedThread = (key: string) => {
    managedThreads.delete(key);
    managedThreads.set(key, true);
    if (managedThreads.size <= SLACK_MANAGED_THREAD_CACHE_MAX_ENTRIES) {
      return;
    }
    const oldestKey = managedThreads.keys().next().value;
    if (oldestKey !== undefined) {
      managedThreads.delete(oldestKey);
    }
  };

  const recordManagedThread = async (channelId: string, threadTs: string) => {
    const key = managedThreadKey(channelId, threadTs);
    rememberManagedThread(key);
    const stateKey = managedThreadStateKey(channelId, threadTs);
    const openedStore = stateKey ? openThreadStore() : undefined;
    if (!openedStore || !stateKey) {
      return;
    }
    try {
      await openedStore.register(stateKey, {
        experience: "managed-thread",
        observedAt: Date.now(),
      });
    } catch (error) {
      warnOnce("persist", error);
    }
  };

  const isManagedThread = async (channelId: string, threadTs: string) => {
    const key = managedThreadKey(channelId, threadTs);
    if (managedThreads.has(key)) {
      return true;
    }
    const stateKey = managedThreadStateKey(channelId, threadTs);
    const openedStore = stateKey ? openThreadStore() : undefined;
    if (!openedStore || !stateKey) {
      return false;
    }
    try {
      const stored = await openedStore.lookup(stateKey);
      const found = stored?.experience === "managed-thread";
      if (found) {
        rememberManagedThread(key);
      }
      return found;
    } catch (error) {
      warnOnce("load", error);
      return false;
    }
  };

  return { isEnabled, isManagedThread, record, recordManagedThread };
}
