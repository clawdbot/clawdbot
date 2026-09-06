// Shared directive persistence and lifecycle fixtures for model and mixed-message tests.
import { afterEach, beforeEach, vi } from "vitest";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  persistenceMocks,
  type PersistenceResult,
} from "./directive-handling.mixed-inline.test-mocks.js";

export { persistenceMocks, type PersistenceResult };

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
