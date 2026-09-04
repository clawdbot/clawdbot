// GLM <tool_call>exec<arg_key> cases live beside assistant-visible-text.test.ts,
// which sits at the max-lines cap.
import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  stripAssistantInternalScaffolding,
} from "./assistant-visible-text.js";

describe("stripAssistantInternalScaffolding GLM arg_key", () => {
  function expectVisibleText(input: string, expected: string) {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  }

  it("strips GLM-style <tool_call>exec<arg_key> shadow XML (#61645)", () => {
    expectVisibleText(
      "<tool_call>exec<arg_key>command</arg_key><arg_value>cd /home/hiiy/.openclaw && gh pr list --repo openclaw/openclaw --limit 10 --state open</arg_value><arg_key>timeout</arg_key><arg_value>30</arg_value></tool_call>",
      "",
    );
    expectVisibleText(
      "Checking.\n<tool_call>read<arg_key>path</arg_key><arg_value>/tmp/x</arg_value></tool_call>",
      "Checking.\n",
    );
  });

  it("strips dangling <tool_call> followed by <arg_key> to end", () => {
    expectVisibleText(
      "Checking.\n<tool_call>\n<arg_key>name</arg_key>\n<arg_value>read",
      "Checking.\n",
    );
  });

  it("holds an incomplete <tool_call>exec prefix until GLM args arrive", () => {
    expectVisibleText("Visible\n<tool_call>exec", "Visible\n");
    expectVisibleText("Visible\n<tool_call>exec<arg_key>", "Visible\n");
  });

  it("preserves literal exec<arg_key> syntax outside a GLM tool-call block", () => {
    expectVisibleText(
      "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
      "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
    );
    expectVisibleText(
      "Use <tool_call>exec<arg_key> literally.",
      "Use <tool_call>exec<arg_key> literally.",
    );
  });
});

describe("sanitizeAssistantVisibleText GLM arg_key", () => {
  it("strips GLM-style <tool_call>exec<arg_key> shadow XML on the delivery path (#61645)", () => {
    expect(
      sanitizeAssistantVisibleText(
        "<tool_call>exec<arg_key>command</arg_key><arg_value>cd /home/hiiy/.openclaw && gh pr list --repo openclaw/openclaw --limit 10 --state open</arg_value><arg_key>timeout</arg_key><arg_value>30</arg_value></tool_call>",
      ),
    ).toBe("");
    expect(sanitizeAssistantVisibleText("Use <tool_call><arg> literally.")).toBe(
      "Use <tool_call><arg> literally.",
    );
    expect(
      sanitizeAssistantVisibleText(
        "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
      ),
    ).toBe("Models emit exec<arg_key>command</arg_key> next to a structured tool call.");
    expect(sanitizeAssistantVisibleText("Visible\n<tool_call>exec")).toBe("Visible");
  });
});
