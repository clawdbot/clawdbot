/** Tests the ACP SDK's public JSON Schema against representative protocol payloads. */
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import acpProtocolSchema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { type JsonSchemaValue, validateJsonSchemaValue } from "../plugins/schema-validator.js";

function acpSchema(name: keyof typeof acpProtocolSchema.$defs): JsonSchemaValue {
  return {
    ...acpProtocolSchema.$defs[name],
    $defs: acpProtocolSchema.$defs,
  } as JsonSchemaValue;
}

type SchemaFixture = {
  name: string;
  schema: JsonSchemaValue;
  valid: unknown;
  invalid: unknown;
};

const fixtures: SchemaFixture[] = [
  {
    name: "initialize",
    schema: acpSchema("InitializeRequest"),
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
    schema: acpSchema("NewSessionRequest"),
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
    schema: acpSchema("PromptRequest"),
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
    schema: acpSchema("SessionNotification"),
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
    schema: acpSchema("ListSessionsRequest"),
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
    schema: acpSchema("LoadSessionRequest"),
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
    schema: acpSchema("ResumeSessionRequest"),
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
    schema: acpSchema("CloseSessionRequest"),
    valid: {
      sessionId: "agent:main:work",
    },
    invalid: {
      sessionId: null,
    },
  },
];

describe("ACP SDK protocol schema fixtures", () => {
  it.each(fixtures)(
    "$name validates representative payloads",
    ({ name, schema, valid, invalid }) => {
      expect(
        validateJsonSchemaValue({
          schema,
          cacheKey: `acp:${name}`,
          value: valid,
        }).ok,
      ).toBe(true);
      expect(
        validateJsonSchemaValue({
          schema,
          cacheKey: `acp:${name}`,
          value: invalid,
        }).ok,
      ).toBe(false);
    },
  );
});
