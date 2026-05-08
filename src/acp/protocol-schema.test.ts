import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  zCloseSessionRequest,
  zInitializeRequest,
  zListSessionsRequest,
  zLoadSessionRequest,
  zNewSessionRequest,
  zPromptRequest,
  zResumeSessionRequest,
  zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { describe, expect, it } from "vitest";

type SchemaFixture = {
  name: string;
  schema: {
    safeParse: (input: unknown) => { success: boolean };
  };
  valid: unknown;
  invalid: unknown;
};

const fixtures: SchemaFixture[] = [
  {
    name: "initialize",
    schema: zInitializeRequest,
    valid: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
    invalid: {
      protocolVersion: "1",
      clientCapabilities: {},
    },
  },
  {
    name: "session/new",
    schema: zNewSessionRequest,
    valid: {
      cwd: "/tmp/openclaw",
      mcpServers: [],
    },
    invalid: {
      cwd: 42,
      mcpServers: [],
    },
  },
  {
    name: "session/prompt",
    schema: zPromptRequest,
    valid: {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    },
    invalid: {
      sessionId: "session-1",
      prompt: [{ type: "text" }],
    },
  },
  {
    name: "session/update",
    schema: zSessionNotification,
    valid: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    },
    invalid: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    },
  },
  {
    name: "session/list",
    schema: zListSessionsRequest,
    valid: {
      cwd: "/tmp/openclaw",
      cursor: null,
    },
    invalid: {
      cwd: "/tmp/openclaw",
      cursor: 123,
    },
  },
  {
    name: "session/load",
    schema: zLoadSessionRequest,
    valid: {
      sessionId: "agent:main:work",
      cwd: "/tmp/openclaw",
      mcpServers: [],
    },
    invalid: {
      sessionId: "agent:main:work",
      mcpServers: [],
    },
  },
  {
    name: "session/resume",
    schema: zResumeSessionRequest,
    valid: {
      sessionId: "agent:main:work",
      cwd: "/tmp/openclaw",
      mcpServers: [],
    },
    invalid: {
      sessionId: "agent:main:work",
      cwd: 42,
      mcpServers: [],
    },
  },
  {
    name: "session/close",
    schema: zCloseSessionRequest,
    valid: {
      sessionId: "agent:main:work",
    },
    invalid: {
      sessionId: null,
    },
  },
];

describe("ACP SDK protocol schema fixtures", () => {
  it.each(fixtures)("$name validates representative payloads", ({ schema, valid, invalid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });
});
