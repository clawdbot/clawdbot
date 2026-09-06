// Shared directive persistence and lifecycle fixtures for model and mixed-message tests.
import { afterEach, beforeEach, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  loadProviderScopedThinkingCatalog,
  persistenceMocks,
  persistStickyModelSelectionBestEffort,
} from "./directive-handling.mixed-inline.test-mocks.js";

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
