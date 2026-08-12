import { describe, expect, it } from "vitest";
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
      command:
        "openclaw resume 'Agent:Work:Case'\\''Sensitive' --url wss://gateway.example/openclaw",
    },
    {
      name: "qualifies a bare key with the row agent",
      input: {
        gatewayUrl: "ws://127.0.0.1:18789/control",
        sessionKey: "deploy's shell $(touch nope)",
        rowAgentId: "build's agent",
        selectedAgentId: "fallback",
      },
      command:
        "openclaw resume 'agent:build'\\''s agent:deploy'\\''s shell $(touch nope)' --url ws://127.0.0.1:18789/control",
    },
    {
      name: "uses the selected agent only when the row agent is absent",
      input: {
        gatewayUrl: "wss://gateway.example/ws",
        sessionKey: "main",
        selectedAgentId: "selected",
      },
      command: "openclaw resume agent:selected:main --url wss://gateway.example/ws",
    },
  ])("$name", ({ input, command }) => {
    expect(buildContinueInTerminalCommand(input)).toBe(command);
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
