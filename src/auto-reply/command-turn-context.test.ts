import { describe, expect, it } from "vitest";
import { isExplicitCommandTurn, resolveCommandTurnContext } from "./command-turn-context.js";

describe("resolveCommandTurnContext", () => {
  it("derives native command turns from legacy context fields", () => {
    expect(
      resolveCommandTurnContext({
        CommandSource: "native",
        CommandAuthorized: true,
        CommandBody: "/status now",
      }),
    ).toEqual({
      kind: "native",
      source: "native",
      authorized: true,
      commandName: "status",
      body: "/status now",
    });
  });

  it("derives text slash command turns from legacy context fields", () => {
    expect(
      resolveCommandTurnContext({
        CommandSource: "text",
        CommandAuthorized: true,
        CommandBody: "/model gpt-5.5",
      }),
    ).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "model",
    });
  });

  it("keeps normal message turns non-explicit even when command auth is true elsewhere", () => {
    const commandTurn = resolveCommandTurnContext({
      CommandAuthorized: true,
      CommandBody: "hello",
    });
    expect(commandTurn).toMatchObject({
      kind: "normal",
      source: "message",
      authorized: false,
    });
    expect(isExplicitCommandTurn(commandTurn)).toBe(false);
  });

  it("lets structured command turns override legacy command fields", () => {
    expect(
      resolveCommandTurnContext({
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: false,
          commandName: "status",
          body: "/status",
        },
        CommandSource: "native",
        CommandAuthorized: true,
      }),
    ).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: false,
      commandName: "status",
      body: "/status",
    });
  });

  it("rejects inconsistent structured command turn pairs", () => {
    expect(
      resolveCommandTurnContext({
        CommandTurn: {
          kind: "native",
          source: "message",
          authorized: true,
        },
        CommandSource: "text",
        CommandAuthorized: true,
        CommandBody: "/status",
      }),
    ).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
    });
  });
});
