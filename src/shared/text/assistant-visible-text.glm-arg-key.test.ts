// GLM <tool_call>exec<arg_key> cases live beside assistant-visible-text.test.ts,
// which sits at the max-lines cap.
import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
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
      "Checking.\n<tool_call>read\n<arg_key>name</arg_key>\n<arg_value>read",
      "Checking.\n",
    );
  });

  it("holds an incomplete <arg_key> prefix to end on final delivery", () => {
    expectVisibleText("Visible\n<tool_call>exec<arg_key>", "Visible\n");
    expectVisibleText("Visible\n<tool_call>exec<arg_", "Visible\n");
    expectVisibleText("Visible\n<tool_call>exec<arg_ke", "Visible\n");
  });

  it("preserves terminal literal <tool_call>exec prose", () => {
    expectVisibleText("Use <tool_call>exec", "Use <tool_call>exec");
    expectVisibleText("Use <tool_call>exec ", "Use <tool_call>exec ");
    expectVisibleText("Use <tool_call>exec\n", "Use <tool_call>exec\n");
    expectVisibleText("Use <tool_call>x", "Use <tool_call>x");
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
    expectVisibleText(
      "prefix <tool_call><arg_key>secret</arg_key></tool_call> suffix",
      "prefix <tool_call><arg_key>secret</arg_key></tool_call> suffix",
    );
    expectVisibleText(
      "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
      "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
    );
  });

  it("holds a split </arg_key> close on the first payload", () => {
    expectVisibleText("Visible\n<tool_call>exec<arg_key>command</arg_", "Visible\n");
    expectVisibleText("Visible\n<tool_call>exec<arg_key>command</arg", "Visible\n");
    expectVisibleText("Visible\n<tool_call>exec<arg_key>command</", "Visible\n");
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
        "prefix <tool_call><arg_key>secret</arg_key></tool_call> suffix",
      ),
    ).toBe("prefix <tool_call><arg_key>secret</arg_key></tool_call> suffix");
    expect(
      sanitizeAssistantVisibleText(
        "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
      ),
    ).toBe("Models emit exec<arg_key>command</arg_key> next to a structured tool call.");
    expect(sanitizeAssistantVisibleText("Use <tool_call>exec")).toBe("Use <tool_call>exec");
    expect(sanitizeAssistantVisibleText("Use <tool_call>exec ")).toBe("Use <tool_call>exec");
    expect(sanitizeAssistantVisibleText("Use <tool_call>exec\n")).toBe("Use <tool_call>exec");
    expect(
      sanitizeAssistantVisibleText(
        "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
      ),
    ).toBe("Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.");
  });

  it("holds a name-only GLM prefix only while streaming", () => {
    expect(
      sanitizeAssistantVisibleTextWithProfile("Visible\n<tool_call>exec", "delivery", true),
    ).toBe("Visible");
    expect(
      sanitizeAssistantVisibleTextWithProfile("Visible\n<tool_call>exec ", "delivery", true),
    ).toBe("Visible");
    expect(sanitizeAssistantVisibleTextWithProfile("Visible\n<tool_call>x", "delivery", true)).toBe(
      "Visible",
    );
  });
});
