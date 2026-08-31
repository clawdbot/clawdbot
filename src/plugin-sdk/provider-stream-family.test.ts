import { describe, expect, it } from "vitest";
import * as providerStreamFamily from "./provider-stream-family.js";
import * as providerStream from "./provider-stream.js";

const COMPATIBILITY_EXPORT_NAMES = [
  "GOOGLE_THINKING_STREAM_HOOKS",
  "KILOCODE_THINKING_STREAM_HOOKS",
  "MINIMAX_FAST_MODE_STREAM_HOOKS",
  "MOONSHOT_THINKING_STREAM_HOOKS",
  "OPENAI_RESPONSES_STREAM_HOOKS",
  "OPENROUTER_THINKING_STREAM_HOOKS",
  "TOOL_STREAM_DEFAULT_ON_HOOKS",
] as const;

describe("provider-stream-family compatibility exports", () => {
  it.each(COMPATIBILITY_EXPORT_NAMES)("preserves the shipped %s shortcut", (exportName) => {
    const value = providerStreamFamily[exportName];

    expect(value).toBeDefined();
    expect(value).toHaveProperty("wrapStreamFn");
    expect(value).toBe(providerStream[exportName]);
  });
});
