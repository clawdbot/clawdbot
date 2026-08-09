import "./generated-media-task-activity.js";

type GeneratedMediaTaskActivityTestApi = {
  resetGeneratedMediaTaskActivityForTests(): void;
};

function getTestApi(): GeneratedMediaTaskActivityTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.generatedMediaTaskActivityTestApi")
  ];
  if (!api) {
    throw new Error("generated media task activity test API is unavailable");
  }
  return api as GeneratedMediaTaskActivityTestApi;
}

export function resetGeneratedMediaTaskActivityForTests(): void {
  getTestApi().resetGeneratedMediaTaskActivityForTests();
}
