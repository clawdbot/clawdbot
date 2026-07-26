import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";

export type ToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

export type ToolDisplayRegistry = Record<string, ToolDisplaySpec>;

export type ToolDisplayConfig = {
  version: number;
  fallback: ToolDisplaySpec;
  tools: ToolDisplayRegistry;
};
