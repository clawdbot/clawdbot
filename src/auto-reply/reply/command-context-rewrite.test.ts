import { describe, expect, it } from "vitest";
import { applyCommandTextToContext, applyCommandTextToParams } from "./command-context-rewrite.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const TEXT_FIELDS = [
  "commandText",
  "agentText",
  "rawText",
  "Body",
  "RawBody",
  "CommandBody",
  "BodyForCommands",
  "BodyForAgent",
  "BodyStripped",
] as const;

function expectTextFields(ctx: Record<string, unknown>, text: string): void {
  for (const field of TEXT_FIELDS) {
    expect(ctx[field]).toBe(text);
  }
}

describe("command context rewrite", () => {
  it("updates every text projection on one context", () => {
    const ctx = { Body: "/command old" };

    applyCommandTextToContext(ctx, "new prompt");

    expectTextFields(ctx, "new prompt");
  });

  it("updates the command, inbound context, and distinct root context", () => {
    const params = buildCommandTestParams("/command old", {});
    params.rootCtx = { Body: "/command old" };

    applyCommandTextToParams(params, "new prompt");

    expectTextFields(params.ctx, "new prompt");
    expectTextFields(params.rootCtx, "new prompt");
    expect(params.command.rawBodyNormalized).toBe("new prompt");
    expect(params.command.commandBodyNormalized).toBe("new prompt");
  });
});
