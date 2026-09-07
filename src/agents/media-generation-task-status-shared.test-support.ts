import "./media-generation-task-status-shared.js";

type MediaGenerationDuplicateGuardTestApi = {
  resetRecentMediaGenerationDuplicateGuardsForTests(): void;
};

function getTestApi(): MediaGenerationDuplicateGuardTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaGenerationDuplicateGuardTestApi")
  ] as MediaGenerationDuplicateGuardTestApi;
}

export function resetRecentMediaGenerationDuplicateGuardsForTests(): void {
  getTestApi().resetRecentMediaGenerationDuplicateGuardsForTests();
}
