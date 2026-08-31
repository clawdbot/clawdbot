import "./ask-user-tool.js";

type AskUserToolTestApi = {
  resetPendingAskUserQuestionsForTest(): void;
};

function getTestApi(): AskUserToolTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.askUserToolTestApi")
  ];
  if (!api) {
    throw new Error("ask_user tool test API is unavailable");
  }
  return api as AskUserToolTestApi;
}

export function resetPendingAskUserQuestionsForTest(): void {
  getTestApi().resetPendingAskUserQuestionsForTest();
}
