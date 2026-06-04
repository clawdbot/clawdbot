/** Tests command-turn context normalization and source/kind conversions. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
} from "./command-turn-context.js";
import { isExplicitCommandTurnContext } from "./command-turn-detection.js";

const emptyConfig = {} as const satisfies OpenClawConfig;

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

  it("treats authorized control command bodies as explicit without legacy source tags", () => {
    expect(
      isExplicitCommandTurnContext(
        {
          CommandAuthorized: true,
          CommandBody: "/reset",
        },
        emptyConfig,
      ),
    ).toBe(true);
    expect(
      isExplicitCommandTurnContext(
        {
          CommandAuthorized: true,
          CommandBody: "hey can you /status please",
        },
        emptyConfig,
      ),
    ).toBe(false);
  });

  it("keeps structured normal command turns non-explicit", () => {
    expect(
      isExplicitCommandTurnContext(
        {
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
            body: "/think high through this",
          },
          CommandAuthorized: true,
          Body: "through this",
          RawBody: "through this",
          CommandBody: "/think high through this",
        },
        emptyConfig,
      ),
    ).toBe(false);
  });

  it("uses cleaned command bodies for command-shaped structured normal turns", () => {
    expect(
      isExplicitCommandTurnContext(
        {
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
            body: "/reset",
          },
          CommandAuthorized: true,
          Body: "/reset@openclaw",
          RawBody: "/reset@openclaw",
          CommandBody: "/reset",
        },
        emptyConfig,
      ),
    ).toBe(true);
  });

  it("normalizes bot-mentioned command bodies for structured normal turns", () => {
    expect(
      isExplicitCommandTurnContext(
        {
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
            body: "/reset@openclaw",
          },
          CommandAuthorized: true,
          Body: "/reset@openclaw",
          RawBody: "/reset@openclaw",
          CommandBody: "/reset@openclaw",
          BotUsername: "openclaw",
        },
        emptyConfig,
      ),
    ).toBe(true);
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

  it("exposes native/text helper predicates and target session resolution", () => {
    const nativeTurn = createCommandTurnContext("native", {
      authorized: true,
      body: "/stop",
    });
    const textTurn = createCommandTurnContext("text", {
      authorized: true,
      body: "/status",
    });

    expect(isNativeCommandTurn(nativeTurn)).toBe(true);
    expect(isAuthorizedTextSlashCommandTurn(textTurn)).toBe(true);
    expect(
      resolveCommandTurnTargetSessionKey({
        CommandTurn: nativeTurn,
        CommandTargetSessionKey: " target-session ",
      }),
    ).toBe("target-session");
    expect(
      resolveCommandTurnTargetSessionKey({
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: " legacy-target ",
      }),
    ).toBe("legacy-target");
    expect(isExplicitCommandTurn(undefined)).toBe(false);
  });
});
