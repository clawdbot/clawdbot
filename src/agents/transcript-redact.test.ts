import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

/** Typed accessor for `content` on AgentMessage.
 * AgentMessage is a union that includes custom message types (e.g. BashExecutionMessage)
 * which have no `content` field. Direct `.content` access fails tsgo's strict union check.
 */
function msgContent(msg: AgentMessage): unknown {
  return (msg as unknown as { content: unknown }).content;
}

function textMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function cfg(mode: "tools" | "off", patterns?: string[]): OpenClawConfig {
  return {
    logging: {
      redactSensitive: mode,
      ...(patterns ? { redactPatterns: patterns } : {}),
    },
  } satisfies OpenClawConfig;
}

const EMAIL_PATTERN = String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`;

describe("redactTranscriptMessage", () => {
  it("redacts text block matching default patterns (sk- token)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz end");
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const text = (msgContent(result) as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("sk-abcdef1234567890xyz");
    expect(text).toContain("end");
  });

  it("redacts thinking block", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret sk-abcdef1234567890xyz", thinkingSignature: "sig" },
      ],
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ thinking: string }>)[0];
    expect(block.thinking).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts partialJson block", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCallDelta", partialJson: '{"key":"sk-abcdef1234567890xyz"}' }],
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ partialJson: string }>)[0];
    expect(block.partialJson).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts nested strings in assistant tool-call arguments", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "shell",
          arguments: {
            command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
            env: { nested: ["token sk-abcdef1234567890xyz"] },
            count: 1,
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ arguments: unknown }>)[0];
    const argumentsValue = block.arguments as {
      command: string;
      env: { nested: string[] };
      count: number;
    };
    const serializedArguments = JSON.stringify(block.arguments);
    expect(serializedArguments).not.toContain("sk-abcdef1234567890xyz");
    expect(argumentsValue.command).toBe("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(argumentsValue.env.nested[0]).toBe("token sk-abc…0xyz");
    expect(argumentsValue.count).toBe(1);
    expect(serializedArguments).toContain("openclaw health");
    expect(block.arguments).not.toBe(
      (msgContent(msg) as Array<{ arguments: unknown }>)[0].arguments,
    );
  });

  it("redacts structured secret fields in assistant tool-call arguments", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {
            apiKey: "plainsecretvalue123",
            password: "hunter2",
            nested: { accessToken: ["nestedplainsecret123"] },
            safe: "visible",
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ arguments: unknown }>)[0];
    const argumentsValue = block.arguments as {
      apiKey: string;
      password: string;
      nested: { accessToken: string[] };
      safe: string;
    };
    const serializedArguments = JSON.stringify(block.arguments);
    expect(serializedArguments).not.toContain("plainsecretvalue123");
    expect(serializedArguments).not.toContain("hunter2");
    expect(serializedArguments).not.toContain("nestedplainsecret123");
    expect(argumentsValue.apiKey).toBe("plains…e123");
    expect(argumentsValue.password).toBe("***");
    expect(argumentsValue.nested.accessToken[0]).toBe("nested…t123");
    expect(serializedArguments).toContain("visible");
  });

  it("redacts structured tool-use input payloads", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolUse",
          id: "call_1",
          name: "send_request",
          input: {
            apiKey: "plainsecretvalue123",
            nested: { accessToken: ["nestedplainsecret123"] },
            command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
            safe: "visible",
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ input: unknown }>)[0];
    const inputValue = block.input as {
      apiKey: string;
      nested: { accessToken: string[] };
      command: string;
      safe: string;
    };
    const serializedInput = JSON.stringify(block.input);
    expect(serializedInput).not.toContain("plainsecretvalue123");
    expect(serializedInput).not.toContain("nestedplainsecret123");
    expect(serializedInput).not.toContain("sk-abcdef1234567890xyz");
    expect(inputValue.apiKey).toBe("plains…e123");
    expect(inputValue.nested.accessToken[0]).toBe("nested…t123");
    expect(inputValue.command).toBe("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(serializedInput).toContain("visible");
  });

  it("redacts defensive function-call input payloads", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "functionCall",
          id: "call_1",
          name: "send_request",
          input: {
            password: "hunter2",
            nested: { accessToken: ["nestedplainsecret123"] },
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<{ input: unknown }>)[0];
    const inputValue = block.input as {
      password: string;
      nested: { accessToken: string[] };
    };
    const serializedInput = JSON.stringify(block.input);
    expect(serializedInput).not.toContain("hunter2");
    expect(serializedInput).not.toContain("nestedplainsecret123");
    expect(inputValue.password).toBe("***");
    expect(inputValue.nested.accessToken[0]).toBe("nested…t123");
  });

  it("redacts arbitrary gateway/custom content-block fields recursively", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "gatewayCustom",
          source: {
            url: "https://example.com/callback?token=sk-abcdef1234567890xyz",
          },
          data: {
            apiKey: "plainsecretvalue123",
            nested: {
              accessToken: "nestedplainsecret123",
            },
          },
          safe: "visible",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (msgContent(result) as Array<Record<string, unknown>>)[0];
    const serializedBlock = JSON.stringify(block);
    expect(serializedBlock).not.toContain("sk-abcdef1234567890xyz");
    expect(serializedBlock).not.toContain("plainsecretvalue123");
    expect(serializedBlock).not.toContain("nestedplainsecret123");
    expect(serializedBlock).toContain("visible");
  });

  it("redacts circular structured payloads without throwing", () => {
    const details: Record<string, unknown> = {
      apiKey: "plainsecretvalue123",
    };
    details.self = details;
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "send_request",
      content: [{ type: "text", text: "result" }],
      details,
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools")) as unknown as {
      details: Record<string, unknown>;
    };
    expect(result.details.apiKey).toBe("plains…e123");
    expect(result.details.self).toBe("[Circular]");
  });

  it("redacts structured secret fields in tool-result details", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "send_request",
      content: [{ type: "text", text: "result sk-abcdef1234567890xyz" }],
      details: {
        apiKey: "plainsecretvalue123",
        password: "hunter2",
        nested: { accessToken: ["nestedplainsecret123"] },
        safe: "visible",
      },
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools")) as unknown as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    const serializedDetails = JSON.stringify(result.details);
    const details = result.details as {
      apiKey: string;
      password: string;
      nested: { accessToken: string[] };
      safe: string;
    };
    expect(result.content[0].text).not.toContain("sk-abcdef1234567890xyz");
    expect(serializedDetails).not.toContain("plainsecretvalue123");
    expect(serializedDetails).not.toContain("hunter2");
    expect(serializedDetails).not.toContain("nestedplainsecret123");
    expect(details.apiKey).toBe("plains…e123");
    expect(details.password).toBe("***");
    expect(details.nested.accessToken[0]).toBe("nested…t123");
    expect(serializedDetails).toContain("visible");
  });

  it("redacts string-form content", () => {
    const msg = {
      role: "user",
      content: "my key is sk-abcdef1234567890xyz",
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    expect(msgContent(result) as string).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts documented transcript text fields on content-less message types", () => {
    const msg = {
      role: "bashExecution",
      command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
      output: "failed with sk-abcdef1234567890xyz",
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools")) as unknown as {
      command: string;
      output: string;
    };
    expect(result.command).not.toContain("sk-abcdef1234567890xyz");
    expect(result.output).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts assistant error and summary transcript fields", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "safe" }],
      errorMessage: "provider rejected sk-abcdef1234567890xyz",
    } as unknown as AgentMessage;
    const summary = {
      role: "compactionSummary",
      summary: "summary mentions sk-abcdef1234567890xyz",
      tokensBefore: 10,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const assistantResult = redactTranscriptMessage(assistant, cfg("tools")) as unknown as {
      errorMessage: string;
    };
    const summaryResult = redactTranscriptMessage(summary, cfg("tools")) as unknown as {
      summary: string;
    };
    expect(assistantResult.errorMessage).not.toContain("sk-abcdef1234567890xyz");
    expect(summaryResult.summary).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts using custom pattern without dropping default patterns", () => {
    const msg = textMessage("email peter@dc.io and key sk-abcdef1234567890xyz ok");
    const result = redactTranscriptMessage(msg, cfg("tools", [EMAIL_PATTERN]));
    const text = (msgContent(result) as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("peter@dc.io");
    expect(text).not.toContain("sk-abcdef1234567890xyz");
    expect(text).toContain("ok");
  });

  it("passes through unchanged when redactSensitive is off", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz");
    const result = redactTranscriptMessage(msg, cfg("off"));
    expect(result).toBe(msg); // same reference; nothing changed
  });

  it("leaves structured tool-call secrets unchanged when redactSensitive is off", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: { apiKey: "plainsecretvalue123", password: "hunter2" },
        },
      ],
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("off"));
    expect(result).toBe(msg);
    expect(JSON.stringify(msgContent(result))).toContain("plainsecretvalue123");
    expect(JSON.stringify(msgContent(result))).toContain("hunter2");
  });

  it("leaves structured tool-result details unchanged when redactSensitive is off", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "send_request",
      content: [{ type: "text", text: "result" }],
      details: { apiKey: "plainsecretvalue123", password: "hunter2" },
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("off")) as unknown as { details: unknown };
    expect(result).toBe(msg);
    expect(JSON.stringify(result.details)).toContain("plainsecretvalue123");
    expect(JSON.stringify(result.details)).toContain("hunter2");
  });

  it("returns same object reference when nothing matches", () => {
    const msg = textMessage("nothing sensitive here");
    const result = redactTranscriptMessage(msg, cfg("tools"));
    expect(result).toBe(msg);
  });

  it("redacts with cfg=undefined (falls back to default patterns)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz");
    const result = redactTranscriptMessage(msg, undefined);
    const text = (msgContent(result) as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("sk-abcdef1234567890xyz");
  });

  it("passes through non-object and null blocks without throwing", () => {
    const msg = {
      role: "assistant",
      content: [null, 42, "raw string"],
    } as unknown as AgentMessage;
    expect(() => redactTranscriptMessage(msg, cfg("tools"))).not.toThrow();
  });
});
