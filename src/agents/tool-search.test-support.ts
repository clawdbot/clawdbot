import type { ToolSearchCatalogEntry, ToolSearchConfig, ToolSearchRuntime } from "./tool-search.js";
import "./tool-search.js";

type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  searchCount: number;
  describeCount: number;
  callCount: number;
};

type ToolSearchTestApi = {
  sessionCatalogs: Map<string, ToolSearchCatalogSession>;
  maxToolSchemaDirectoryPromptChars: number;
  setToolSearchCodeModeSupportedForTest(value: boolean | undefined): void;
  setToolSearchMinCodeTimeoutMsForTest(value: number | undefined): void;
  appendToolSearchCodeStderrTail(current: string, chunk: string): string;
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
  get sessionCatalogs() {
    return getTestApi().sessionCatalogs;
  },
  get maxToolSchemaDirectoryPromptChars() {
    return getTestApi().maxToolSchemaDirectoryPromptChars;
  },
  setToolSearchCodeModeSupportedForTest: (value) =>
    getTestApi().setToolSearchCodeModeSupportedForTest(value),
  setToolSearchMinCodeTimeoutMsForTest: (value) =>
    getTestApi().setToolSearchMinCodeTimeoutMsForTest(value),
  appendToolSearchCodeStderrTail: (current, chunk) =>
    getTestApi().appendToolSearchCodeStderrTail(current, chunk),
  runCodeModeChild: (params) => getTestApi().runCodeModeChild(params),
};
