import { describe, expect, it } from "vitest";
import { decodeResumeHandoff } from "../../../../src/shared/resume-handoff.js";
import { buildContinueInTerminalCommand } from "./continue-in-terminal-command.ts";

describe("buildContinueInTerminalCommand", () => {
  it.each([
    {
      name: "preserves a qualified key and the selected Gateway base path",
      input: {
        gatewayUrl: "wss://gateway.example/openclaw",
        sessionKey: "Agent:Work:Case'Sensitive",
        rowAgentId: "ignored",
        selectedAgentId: "fallback",
      },
      qualifiedKey: "Agent:Work:Case'Sensitive",
    },
    {
      name: "qualifies a bare key with the row agent",
      input: {
        gatewayUrl: "ws://127.0.0.1:18789/control/$&;=()+,![]{}'`/%25PATH%25",
        sessionKey: "deploy-'\"$&;|<>^()%![]{}\\`-%PATH%",
        rowAgentId: "build's agent",
        selectedAgentId: "fallback",
      },
      qualifiedKey: "agent:build's agent:deploy-'\"$&;|<>^()%![]{}\\`-%PATH%",
    },
    {
      name: "uses the selected agent only when the row agent is absent",
      input: {
        gatewayUrl: "wss://gateway.example/ws",
        sessionKey: "main",
        selectedAgentId: "selected",
      },
      qualifiedKey: "agent:selected:main",
    },
  ])("$name", ({ input, qualifiedKey }) => {
    const command = buildContinueInTerminalCommand(input);
    expect(command).toMatch(/^openclaw resume --handoff [A-Za-z0-9_-]+$/u);
    const encoded = command?.slice("openclaw resume --handoff ".length) ?? "";
    expect(decodeResumeHandoff(encoded)).toEqual({
      version: 1,
      sessionKey: qualifiedKey,
      gatewayUrl: input.gatewayUrl,
    });
  });

  it.each([
    ["non-WebSocket protocol", { gatewayUrl: "https://gateway.example", sessionKey: "main" }],
    ["URL userinfo", { gatewayUrl: "wss://user@gateway.example/ws", sessionKey: "main" }],
    ["empty URL userinfo", { gatewayUrl: "wss://@gateway.example/ws", sessionKey: "main" }],
    ["URL query", { gatewayUrl: "wss://gateway.example/ws?token=nope", sessionKey: "main" }],
    ["URL fragment", { gatewayUrl: "wss://gateway.example/ws#frag", sessionKey: "main" }],
    ["URL C0 control", { gatewayUrl: "wss://gateway.example/ws\nnext", sessionKey: "main" }],
    ["key C1 control", { gatewayUrl: "wss://gateway.example/ws", sessionKey: "bad\u0085key" }],
    [
      "agent C0 control",
      {
        gatewayUrl: "wss://gateway.example/ws",
        sessionKey: "main",
        rowAgentId: "bad\u0000agent",
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(buildContinueInTerminalCommand(input)).toBeNull();
  });
});
