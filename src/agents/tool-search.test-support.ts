import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchConfig } from "./tool-search.js";
import "./tool-search.js";

type ToolSearchTestApi = {
  maxToolSchemaDirectoryPromptChars: number;
  setToolSearchCodeModeSupportedForTest(value: boolean | undefined): void;
  setToolSearchMinCodeTimeoutMsForTest(value: number | undefined): void;
  runCodeModeChild(params: {
    code: string;
    config: ToolSearchConfig;
    logs: unknown[];
    parentToolCallId: string;
    runtime: ToolSearchRuntime;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

function getTestApi(): ToolSearchTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.toolSearchTestApi")
  ] as ToolSearchTestApi;
}

export const testing: ToolSearchTestApi = {
  get maxToolSchemaDirectoryPromptChars() {
    return getTestApi().maxToolSchemaDirectoryPromptChars;
  },
  setToolSearchCodeModeSupportedForTest: (value) =>
    getTestApi().setToolSearchCodeModeSupportedForTest(value),
  setToolSearchMinCodeTimeoutMsForTest: (value) =>
    getTestApi().setToolSearchMinCodeTimeoutMsForTest(value),
  runCodeModeChild: (params) => getTestApi().runCodeModeChild(params),
};
