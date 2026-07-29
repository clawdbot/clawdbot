import { describe, expect, it } from "vitest";
import {
  GOOGLE_THINKING_STREAM_HOOKS,
  KILOCODE_THINKING_STREAM_HOOKS,
  MINIMAX_FAST_MODE_STREAM_HOOKS,
  MOONSHOT_THINKING_STREAM_HOOKS,
  OPENROUTER_THINKING_STREAM_HOOKS,
  TOOL_STREAM_DEFAULT_ON_HOOKS,
} from "./provider-stream-family.js";
import * as providerStream from "./provider-stream.js";

describe("provider-stream-family compatibility exports", () => {
  it.each([
    ["GOOGLE_THINKING_STREAM_HOOKS", GOOGLE_THINKING_STREAM_HOOKS],
    ["KILOCODE_THINKING_STREAM_HOOKS", KILOCODE_THINKING_STREAM_HOOKS],
    ["MINIMAX_FAST_MODE_STREAM_HOOKS", MINIMAX_FAST_MODE_STREAM_HOOKS],
    ["MOONSHOT_THINKING_STREAM_HOOKS", MOONSHOT_THINKING_STREAM_HOOKS],
    ["OPENROUTER_THINKING_STREAM_HOOKS", OPENROUTER_THINKING_STREAM_HOOKS],
    ["TOOL_STREAM_DEFAULT_ON_HOOKS", TOOL_STREAM_DEFAULT_ON_HOOKS],
  ] as const)("preserves the shipped %s shortcut", (exportName, value) => {
    expect(value).toBe(providerStream[exportName]);
  });
});
