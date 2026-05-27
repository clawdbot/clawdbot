import { describe, expect, it } from "vitest";
import { buildApprovalKeyboard, buildPluginApprovalText } from "./index.js";

describe("buildApprovalKeyboard", () => {
  it("omits allow-always when the decision is unavailable", () => {
    const keyboard = buildApprovalKeyboard("approval-123", ["allow-once", "deny"]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "deny"]);
    expect(buttons.map((button) => button.action.data)).toEqual([
      "approve:approval-123:allow-once",
      "approve:approval-123:deny",
    ]);
  });

  it("keeps all buttons when all decisions are allowed", () => {
    const keyboard = buildApprovalKeyboard("approval-123", ["allow-once", "allow-always", "deny"]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "always", "deny"]);
  });
});

describe("buildPluginApprovalText", () => {
  it("renders command-only plugin approval actions as visible text", () => {
    const text = buildPluginApprovalText(
      {
        id: "plugin:req-1",
        request: {
          title: "World proof required",
          description: "Verify with World before the tool runs.",
          pluginId: "agentkit",
          toolName: "shell.exec",
        },
      },
      [
        {
          kind: "command",
          label: "Verify with World",
          style: "primary",
          command: "/agentkit approve plugin:req-1 allow-once",
        },
      ],
    );

    expect(text).toContain("/agentkit approve plugin:req-1 allow-once");
  });
});
