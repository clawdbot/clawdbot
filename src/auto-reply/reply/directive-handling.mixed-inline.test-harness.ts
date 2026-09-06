// Shared directive persistence and lifecycle fixtures for model and mixed-message tests.
import { afterEach, beforeEach, vi } from "vitest";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";

export type PersistenceResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "model-selection-locked"; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

export const persistenceMocks = vi.hoisted(() => ({
  persist: vi.fn<(params: { entry: SessionEntry }) => Promise<PersistenceResult>>(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentIds: vi.fn(() => ({ requestedAgentId: "main", sessionAgentId: "main" })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: (params: { entry: SessionEntry }) => persistenceMocks.persist(params),
}));

export let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;

beforeEach(() => {
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  vi.clearAllMocks();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
  persistenceMocks.persist.mockImplementation(async ({ entry }) => ({
    status: "current",
    entry: { ...entry },
  }));
});

afterEach(() => {
  unsubscribeLifecycle();
  vi.restoreAllMocks();
});
