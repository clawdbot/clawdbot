// Transcript redaction tests cover structured and text transcript fields so
// secrets do not persist in logs or replay artifacts.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as loggingConfigModule from "../logging/config.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

// AgentMessage includes custom message types without content; this accessor
// keeps strict union checks local to the redaction fixtures.
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

function googleCompatCfg(): OpenClawConfig {
  return {
    ...cfg("tools"),
    models: {
      providers: {
        "google-compatible-proxy": {
          api: "openai-completions",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;
}

const EMAIL_PATTERN = String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`;
const IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAARcnVOZAAAAKIDABCDEFGHIJKLMNOP8JJRuAAAAABJRU5ErkJggg==";
const BMP_BASE64_WITH_SECRET_TOKEN_SUBSTRING = Buffer.from(
  "BMsk-abcdef1234567890xyz",
  "ascii",
).toString("base64");
const CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES =
  "gAAAAABpQnQrXzzZqcAfo3unbAY-ku84xgsvB0fpLkbDvSh3WS5qzfSCmcgwr8_abcdefghijvK2RyV2GQ4ohzcfYwhRwTvY76TvR7Tvr_";
const GOOGLE_THOUGHT_SIGNATURE = Buffer.from(`thought-${"x".repeat(32)}`).toString("base64");
const SHORT_GOOGLE_THOUGHT_SIGNATURE = "c2ln";
const GOOGLE_CREDENTIAL_COLLISION = `AAAAAIza${"A".repeat(20)}`;
const ALIBABA_CREDENTIAL_COLLISION = `AAAALTAI${"B".repeat(12)}`;
const OPAQUE_CREDENTIAL_COLLISION = `signature.v2:${GOOGLE_CREDENTIAL_COLLISION}`;
const OPENAI_COMPAT_OPAQUE_COLLISION = `SIG-${GOOGLE_CREDENTIAL_COLLISION}`;
const COPILOT_CONNECTION_BOUND_ID = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
const OPENAI_REASONING_REPLAY_METADATA = {
  v: 1,
  source: "openai-responses",
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
  baseUrlHash: "0123456789abcdef",
  sessionHash: "123456789abcdef0",
  authProfileHash: "23456789abcdef01",
} as const;

describe("redactTranscriptMessage", () => {
  it("redacts text block matching default patterns (sk- token)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz end");
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const text = expectDefined(
      (msgContent(result) as Array<{ text: string }>)[0],
      "(msgContent(result) as Array<{ text: string }>)[0] test invariant",
    ).text;
    expect(text).not.toContain("sk-abcdef1234567890xyz");
    expect(text).toContain("end");
  });

  it("keeps pagination cursors readable while still masking credential tool args (#104992)", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "feishu_doc",
          arguments: {
            page_token: "PGabc123XYZ",
            next_page_token: "NXTpage456",
            page_cursor: "PC789",
            doc_token: "DOCsecret999",
            app_secret: "REALSECRETzzz",
          },
        },
      ],
    } as unknown as AgentMessage;
    const args = (
      msgContent(redactTranscriptMessage(msg, cfg("tools"))) as Array<{
        arguments: Record<string, string>;
      }>
    )[0]!.arguments;
    // Pagination cursors are opaque paging state — replaying a "***" mask as a
    // real cursor silently pages from the start, so keep them intact.
    expect(args.page_token).toBe("PGabc123XYZ");
    expect(args.next_page_token).toBe("NXTpage456");
    expect(args.page_cursor).toBe("PC789");
    // Genuine credentials stay masked.
    expect(args.doc_token).toBe("***");
    expect(args.app_secret).toBe("***");
  });

  it("still masks a secret-shaped value even under an exempt pagination key (#104992)", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "feishu_doc",
          arguments: { page_token: "sk-abcdef1234567890xyz" },
        },
      ],
    } as unknown as AgentMessage;
    const args = (
      msgContent(redactTranscriptMessage(msg, cfg("tools"))) as Array<{
        arguments: Record<string, string>;
      }>
    )[0]!.arguments;
    // Value-pattern redaction still runs on exempt keys, so an embedded real
    // secret shape is masked even though the key itself is allowed through.
    expect(args.page_token).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts thinking block", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret sk-abcdef1234567890xyz", thinkingSignature: "sig" },
      ],
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ thinking: string }>)[0],
      "(msgContent(result) as Array<{ thinking: string }>)[0] test invariant",
    );
    expect(block.thinking).not.toContain("sk-abcdef1234567890xyz");
  });

  it("preserves OpenAI encrypted reasoning inside thinkingSignature", () => {
    const thinkingSignature = JSON.stringify({
      id: "reasoning-1",
      type: "reasoning",
      encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      summary: [{ type: "summary_text", text: "secret sk-abcdef1234567890xyz" }],
      content: [{ type: "reasoning_text", text: "secret sk-abcdef1234567890xyz" }],
      __openclaw_replay: {
        ...OPENAI_REASONING_REPLAY_METADATA,
        secret: "sk-abcdef1234567890xyz",
      },
    });
    const msg = {
      role: "assistant",
      api: "openai-responses",
      model: "gpt-5.5",
      provider: "openai",
      content: [
        {
          type: "thinking",
          thinking: "secret sk-abcdef1234567890xyz",
          thinkingSignature,
          openclawReasoningReplay: {
            ...OPENAI_REASONING_REPLAY_METADATA,
            secret: "sk-abcdef1234567890xyz",
          },
        },
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            status: "future",
            encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
            summary: [{ type: "summary_text", text: "secret sk-abcdef1234567890xyz" }],
          }),
          openclawReasoningReplay: {
            ...OPENAI_REASONING_REPLAY_METADATA,
            model: "sk-abcdef1234567890xyz",
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(
      msg,
      cfg("tools", ["reasoning-1", "reasoning", "summary_text"]),
    );
    const block = expectDefined(
      (msgContent(result) as Array<{ thinking: string; thinkingSignature: string }>)[0],
      "(msgContent(result) as Array<{ thinking: string; thinkingSignature: s... test invariant",
    );
    const replayItem = JSON.parse(block.thinkingSignature) as {
      id: string;
      type: string;
      encrypted_content: string;
      summary: unknown[];
      content?: unknown[];
      __openclaw_replay: Record<string, unknown>;
    };
    const blockMetadata = (block as unknown as { openclawReasoningReplay: Record<string, unknown> })
      .openclawReasoningReplay;
    const rejectedSignature = expectDefined(
      (msgContent(result) as Array<{ thinkingSignature: string }>)[1],
      "(msgContent(result) as Array<{ thinkingSignature: string }>)[1] test invariant",
    ).thinkingSignature;
    expect(block.thinking).not.toContain("sk-abcdef1234567890xyz");
    expect(replayItem.id).toBe("reasoning-1");
    expect(replayItem.type).toBe("reasoning");
    expect(replayItem.encrypted_content).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(replayItem.summary).toEqual([]);
    expect(replayItem.content).toBeUndefined();
    expect(replayItem["__openclaw_replay"]).toEqual(OPENAI_REASONING_REPLAY_METADATA);
    expect(blockMetadata).toEqual(OPENAI_REASONING_REPLAY_METADATA);
    expect(block.thinkingSignature).not.toContain("sk-abcdef1234567890xyz");
    expect(JSON.stringify(blockMetadata)).not.toContain("sk-abcdef1234567890xyz");
    expect(rejectedSignature).not.toContain("sk-abcdef1234567890xyz");
    expect(JSON.stringify(msgContent(result))).not.toContain("sk-abcdef1234567890xyz");
  });

  it("handles configured providers without explicit models", () => {
    const msg = {
      role: "assistant",
      api: "openai-responses",
      model: "gpt-5.5",
      provider: "openai",
      content: [{ type: "text", text: "visible", textSignature: "response-item-1" }],
    } as unknown as AgentMessage;
    const inputCfg = {
      logging: { redactSensitive: "tools" },
      models: { providers: { openai: { apiKey: "test-key" } } },
    } as unknown as OpenClawConfig;

    const result = redactTranscriptMessage(msg, inputCfg) as unknown as {
      api: string;
      model: string;
      provider: string;
      content: Array<{ textSignature: string }>;
    };

    expect(result).toMatchObject({
      api: "openai-responses",
      model: "gpt-5.5",
      provider: "openai",
    });
    expect(expectDefined(result.content[0], "result.content[0] test invariant").textSignature).toBe(
      "response-item-1",
    );
  });

  it.each([
    {
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      block: {
        type: "thinking",
        thinking: "visible",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          summary: [],
        }),
      },
      signatureKey: "thinkingSignature",
      expectedSignature: JSON.stringify({
        type: "reasoning",
        summary: [],
        encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      }),
    },
    {
      api: "openclaw-anthropic-messages-transport",
      provider: "anthropic",
      block: {
        type: "thinking",
        thinking: "visible",
        thinkingSignature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      },
      signatureKey: "thinkingSignature",
      expectedSignature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
    },
    {
      api: "openclaw-google-generative-ai-transport",
      provider: "google",
      block: {
        type: "toolCall",
        id: "call_1",
        name: "send_request",
        arguments: {},
        thoughtSignature: GOOGLE_THOUGHT_SIGNATURE,
      },
      signatureKey: "thoughtSignature",
      expectedSignature: GOOGLE_THOUGHT_SIGNATURE,
    },
    {
      api: "openai-completions",
      provider: "google",
      block: {
        type: "toolCall",
        id: "call_1",
        name: "send_request",
        arguments: {},
        thoughtSignature: SHORT_GOOGLE_THOUGHT_SIGNATURE,
      },
      signatureKey: "thoughtSignature",
      expectedSignature: SHORT_GOOGLE_THOUGHT_SIGNATURE,
    },
    {
      api: "openclaw-openai-completions-transport",
      provider: "google",
      block: {
        type: "toolCall",
        id: "call_1",
        name: "send_request",
        arguments: {},
        thoughtSignature: GOOGLE_THOUGHT_SIGNATURE,
      },
      signatureKey: "thoughtSignature",
      expectedSignature: GOOGLE_THOUGHT_SIGNATURE,
    },
  ])(
    "preserves replay signatures for managed transport $api",
    ({ api, provider, block, signatureKey, expectedSignature }) => {
      const msg = {
        role: "assistant",
        api,
        model: "managed-model",
        provider,
        content: [block],
      } as unknown as AgentMessage;

      const result = redactTranscriptMessage(
        msg,
        cfg("tools", [
          CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          GOOGLE_THOUGHT_SIGNATURE,
          SHORT_GOOGLE_THOUGHT_SIGNATURE,
        ]),
      );
      const preservedBlock = expectDefined(
        (msgContent(result) as Array<Record<string, string>>)[0],
        "(msgContent(result) as Array<Record<string, string>>)[0] test invariant",
      );
      expect(
        expectDefined(preservedBlock[signatureKey], "preservedBlock[signatureKey] test invariant"),
      ).toBe(expectedSignature);
    },
  );

  it("canonicalizes OpenAI-compatible encrypted tool reasoning", () => {
    const thoughtSignature = JSON.stringify({
      type: "reasoning.encrypted",
      data: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      id: "reasoning-encrypted-1",
      format: "anthropic-claude-v1",
      index: 1,
      secret: "sk-abcdef1234567890xyz",
    });
    const msg = {
      role: "assistant",
      api: "openai-completions",
      model: "anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ thoughtSignature: string }>)[0],
      "(msgContent(result) as Array<{ thoughtSignature: string }>)[0] test invariant",
    );
    expect(JSON.parse(block.thoughtSignature)).toEqual({
      type: "reasoning.encrypted",
      data: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      id: "reasoning-encrypted-1",
      format: "anthropic-claude-v1",
      index: 1,
    });
  });

  it("preserves nullable OpenRouter encrypted reasoning format", () => {
    const thoughtSignature = JSON.stringify({
      type: "reasoning.encrypted",
      data: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      format: null,
    });
    const msg = {
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ thoughtSignature: string }>)[0],
      "(msgContent(result) as Array<{ thoughtSignature: string }>)[0] test invariant",
    );
    expect(JSON.parse(block.thoughtSignature)).toEqual({
      type: "reasoning.encrypted",
      data: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      format: null,
    });
  });

  it("preserves Google tool-call thought signatures while redacting arguments", () => {
    const msg = {
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          thoughtSignature: GOOGLE_THOUGHT_SIGNATURE,
          arguments: {
            apiKey: "plainsecretvalue123",
            thinkingSignature: "sk-abcdef1234567890xyz",
            thoughtSignature: "sk-abcdef1234567890xyz",
            thought_signature: "sk-abcdef1234567890xyz",
            encrypted_content: "sk-abcdef1234567890xyz",
            nestedAssistant: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinkingSignature: "sk-abcdef1234567890xyz",
                },
              ],
            },
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (
        msgContent(result) as Array<{
          thoughtSignature: string;
          arguments: Record<string, string>;
        }>
      )[0],
      "( msgContent(result) as Array<{ thoughtSignature: string; arguments: ... test invariant",
    );
    expect(block.thoughtSignature).toBe(GOOGLE_THOUGHT_SIGNATURE);
    expect(JSON.stringify(block.arguments)).not.toContain("sk-abcdef1234567890xyz");
    expect(block.arguments.apiKey).toBe("plains…e123");
  });

  it("preserves Google text and legacy thinking signatures", () => {
    const msg = {
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      content: [
        {
          type: "text",
          text: "secret sk-abcdef1234567890xyz",
          textSignature: GOOGLE_THOUGHT_SIGNATURE,
        },
        {
          type: "text",
          text: "visible",
          textSignature: "sk-abcdef1234567890xyz",
        },
        {
          type: "thinking",
          thinking: "secret sk-abcdef1234567890xyz",
          thought_signature: SHORT_GOOGLE_THOUGHT_SIGNATURE,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools", [GOOGLE_THOUGHT_SIGNATURE]));
    const blocks = msgContent(result) as Array<Record<string, string>>;
    expect(expectDefined(blocks[0], "blocks[0] test invariant").text).not.toContain(
      "sk-abcdef1234567890xyz",
    );
    expect(expectDefined(blocks[0], "blocks[0] test invariant").textSignature).toBe(
      GOOGLE_THOUGHT_SIGNATURE,
    );
    expect(expectDefined(blocks[1], "blocks[1] test invariant").textSignature).not.toContain(
      "sk-abcdef1234567890xyz",
    );
    expect(expectDefined(blocks[2], "blocks[2] test invariant").thinking).not.toContain(
      "sk-abcdef1234567890xyz",
    );
    expect(expectDefined(blocks[2], "blocks[2] test invariant").thought_signature).toBe(
      SHORT_GOOGLE_THOUGHT_SIGNATURE,
    );
  });

  it.each(["openai-responses", "openclaw-openai-responses-transport"])(
    "preserves structured OpenAI text signatures for %s",
    (api) => {
      const textSignature = JSON.stringify({ v: 1, id: COPILOT_CONNECTION_BOUND_ID });
      const msg = {
        role: "assistant",
        api,
        provider: "github-copilot",
        content: [{ type: "text", text: "visible", textSignature }],
      } as unknown as AgentMessage;

      const result = redactTranscriptMessage(msg, cfg("tools", [COPILOT_CONNECTION_BOUND_ID]));
      const block = expectDefined(
        (msgContent(result) as Array<{ textSignature: string }>)[0],
        "(msgContent(result) as Array<{ textSignature: string }>)[0] test invariant",
      );
      expect(block.textSignature).toBe(textSignature);
    },
  );

  it.each([
    ["openai-completions", "openrouter", "deepseek/deepseek-v4-flash"],
    ["anthropic-messages", "anthropic", "claude-sonnet-4-6"],
  ])("preserves commentary phase signatures for %s", (api, provider, model) => {
    const textSignature = JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" });
    const msg = {
      role: "assistant",
      api,
      provider,
      model,
      content: [{ type: "text", text: "I will check.", textSignature }],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ textSignature: string }>)[0],
      "commentary text block",
    );
    expect(block.textSignature).toBe(textSignature);
  });

  it("preserves Anthropic redacted_thinking data while redacting siblings", () => {
    const msg = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      content: [
        {
          type: "thinking",
          thinking: "secret sk-abcdef1234567890xyz",
          thinkingSignature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          redacted: true,
        },
        {
          type: "redacted_thinking",
          data: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          signature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          thinkingSignature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          metadata: {
            accessToken: "nestedplainsecret123",
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const thinkingBlock = expectDefined(
      (msgContent(result) as Array<{ thinking: string; thinkingSignature: string }>)[0],
      "( msgContent(result) as Array<{ thinking: string; thinkingSignature: ... test invariant",
    );
    const redactedBlock = expectDefined(
      (
        msgContent(result) as Array<{
          data: string;
          signature: string;
          thinkingSignature: string;
          metadata: { accessToken: string };
        }>
      )[1],
      "( msgContent(result) as Array<{ data: string; signature: string; thin... test invariant",
    );
    expect(thinkingBlock.thinking).not.toContain("sk-abcdef1234567890xyz");
    expect(thinkingBlock.thinkingSignature).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(redactedBlock.data).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(redactedBlock.signature).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(redactedBlock.thinkingSignature).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(redactedBlock.metadata.accessToken).toBe("nested…t123");
  });

  it("preserves credential-shaped bytes in recognized provider replay fields", () => {
    const githubToken = `ghp_${"b".repeat(36)}`;
    const encryptedDetail = JSON.stringify({
      type: "reasoning.encrypted",
      data: githubToken,
      id: "reasoning-encrypted-1",
      secret: "sk-abcdef1234567890xyz",
    });
    const googleMsg = {
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: GOOGLE_CREDENTIAL_COLLISION,
        },
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: ALIBABA_CREDENTIAL_COLLISION,
        },
      ],
    } as unknown as AgentMessage;
    const anthropicMsg = {
      role: "assistant",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      content: [
        {
          type: "thinking",
          thinking: "visible",
          signature: OPENAI_COMPAT_OPAQUE_COLLISION,
        },
        { type: "redacted_thinking", data: githubToken },
      ],
    } as unknown as AgentMessage;
    const openAICompletionsMsg = {
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: encryptedDetail,
        },
        {
          type: "toolCall",
          id: "call_secret",
          name: "send_request",
          arguments: {},
          thoughtSignature: githubToken,
        },
      ],
    } as unknown as AgentMessage;
    const googleOpenAICompletionsMsg = {
      role: "assistant",
      api: "openclaw-openai-completions-transport",
      model: "gemini-3.1-pro",
      provider: "google-compatible-proxy",
      content: [
        {
          type: "toolCall",
          id: "call_2",
          name: "send_request",
          arguments: {},
          thoughtSignature: OPENAI_COMPAT_OPAQUE_COLLISION,
        },
      ],
    } as unknown as AgentMessage;
    const openAIResponsesMsg = {
      role: "assistant",
      api: "openai-responses",
      model: "gpt-5.5",
      provider: "openai",
      content: [
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: JSON.stringify({
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: GOOGLE_CREDENTIAL_COLLISION,
            summary: [{ type: "summary_text", text: "secret sk-abcdef1234567890xyz" }],
            secret: "sk-abcdef1234567890xyz",
          }),
        },
      ],
    } as unknown as AgentMessage;

    const googleBlocks = msgContent(redactTranscriptMessage(googleMsg, cfg("tools"))) as Array<
      Record<string, string>
    >;
    expect(expectDefined(googleBlocks[0], "googleBlocks[0] test invariant").thoughtSignature).toBe(
      GOOGLE_CREDENTIAL_COLLISION,
    );
    expect(expectDefined(googleBlocks[1], "googleBlocks[1] test invariant").thinkingSignature).toBe(
      ALIBABA_CREDENTIAL_COLLISION,
    );

    const anthropicBlocks = msgContent(
      redactTranscriptMessage(anthropicMsg, cfg("tools")),
    ) as Array<Record<string, string>>;
    expect(expectDefined(anthropicBlocks[0], "anthropicBlocks[0] test invariant").signature).toBe(
      OPENAI_COMPAT_OPAQUE_COLLISION,
    );
    expect(expectDefined(anthropicBlocks[1], "anthropicBlocks[1] test invariant").data).toBe(
      githubToken,
    );

    const completionsBlocks = msgContent(
      redactTranscriptMessage(openAICompletionsMsg, cfg("tools")),
    ) as Array<{ thoughtSignature: string }>;
    expect(
      JSON.parse(
        expectDefined(completionsBlocks[0], "completionsBlocks[0] test invariant").thoughtSignature,
      ),
    ).toEqual({
      type: "reasoning.encrypted",
      data: githubToken,
      id: "reasoning-encrypted-1",
    });
    expect(
      expectDefined(completionsBlocks[1], "completionsBlocks[1] test invariant").thoughtSignature,
    ).not.toBe(githubToken);

    const googleCompletionsBlock = expectDefined(
      (
        msgContent(
          redactTranscriptMessage(googleOpenAICompletionsMsg, googleCompatCfg()),
        ) as Array<{
          thoughtSignature: string;
        }>
      )[0],
      "( msgContent(redactTranscriptMessage(googleOpenAICompletionsMsg, goog... test invariant",
    );
    expect(googleCompletionsBlock.thoughtSignature).toBe(OPENAI_COMPAT_OPAQUE_COLLISION);

    const responsesBlock = expectDefined(
      (
        msgContent(redactTranscriptMessage(openAIResponsesMsg, cfg("tools"))) as Array<{
          thinkingSignature: string;
        }>
      )[0],
      '( msgContent(redactTranscriptMessage(openAIResponsesMsg, cfg("tools")... test invariant',
    );
    expect(JSON.parse(responsesBlock.thinkingSignature)).toEqual({
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      encrypted_content: GOOGLE_CREDENTIAL_COLLISION,
    });
  });

  it("keeps unknown and malformed replay fields credential-safe", () => {
    const customProviderMsg = {
      role: "assistant",
      api: "custom-provider-api",
      model: "custom-model",
      provider: "custom-provider",
      content: [
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: ALIBABA_CREDENTIAL_COLLISION,
        },
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: JSON.stringify({
            type: "reasoning.encrypted",
            data: GOOGLE_CREDENTIAL_COLLISION,
            id: "reasoning-encrypted-1",
          }),
        },
      ],
    } as unknown as AgentMessage;
    const malformedGoogleMsg = {
      role: "assistant",
      api: "google-generative-ai",
      model: "gemini-3.1-pro",
      provider: "google",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: OPAQUE_CREDENTIAL_COLLISION,
        },
      ],
    } as unknown as AgentMessage;
    const malformedKnownOpaqueMessages = [
      {
        role: "assistant",
        api: "anthropic-messages",
        model: "claude-opus-4-8",
        provider: "anthropic",
        content: [
          {
            type: "thinking",
            thinking: "visible",
            thinkingSignature: "secret sk-abcdef1234567890xyz",
          },
        ],
      },
      {
        role: "assistant",
        api: "openai-completions",
        model: "gemini-3.1-pro",
        provider: "google",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "send_request",
            arguments: {},
            thoughtSignature: "secret sk-abcdef1234567890xyz",
          },
        ],
      },
    ] as unknown as AgentMessage[];

    expect(
      JSON.stringify(msgContent(redactTranscriptMessage(customProviderMsg, cfg("tools")))),
    ).not.toContain(ALIBABA_CREDENTIAL_COLLISION);
    expect(
      JSON.stringify(msgContent(redactTranscriptMessage(customProviderMsg, cfg("tools")))),
    ).not.toContain(GOOGLE_CREDENTIAL_COLLISION);
    expect(
      JSON.stringify(msgContent(redactTranscriptMessage(malformedGoogleMsg, cfg("tools")))),
    ).not.toContain(OPAQUE_CREDENTIAL_COLLISION);
    for (const message of malformedKnownOpaqueMessages) {
      expect(
        JSON.stringify(msgContent(redactTranscriptMessage(message, cfg("tools")))),
      ).not.toContain("sk-abcdef1234567890xyz");
    }
  });

  it("redacts provider-shaped fields when the assistant route is missing", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
        },
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: GOOGLE_THOUGHT_SIGNATURE,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(
      msg,
      cfg("tools", [CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES, GOOGLE_THOUGHT_SIGNATURE]),
    );
    const serialized = JSON.stringify(msgContent(result));
    expect(serialized).not.toContain(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(serialized).not.toContain(GOOGLE_THOUGHT_SIGNATURE);
  });

  it("preserves validated replay signatures for custom provider APIs", () => {
    const reasoningSignature = JSON.stringify({
      type: "reasoning",
      encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
      summary: [],
    });
    const msg = {
      role: "assistant",
      api: "custom-provider-api",
      model: "custom-model",
      provider: "custom-provider",
      content: [
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: reasoningSignature,
        },
        {
          type: "toolCall",
          id: "call_1",
          name: "send_request",
          arguments: {},
          thoughtSignature: SHORT_GOOGLE_THOUGHT_SIGNATURE,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(
      msg,
      cfg("tools", [CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES, SHORT_GOOGLE_THOUGHT_SIGNATURE]),
    );
    const blocks = msgContent(result) as Array<Record<string, string>>;
    expect(
      JSON.parse(
        expectDefined(
          expectDefined(blocks[0], "thinking block").thinkingSignature,
          "thinking signature",
        ),
      ).encrypted_content,
    ).toBe(CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES);
    expect(expectDefined(blocks[1], "blocks[1] test invariant").thoughtSignature).toBe(
      SHORT_GOOGLE_THOUGHT_SIGNATURE,
    );
  });

  it("redacts provider-shaped fields outside direct assistant content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "gatewayCustom",
          data: "secret sk-abcdef1234567890xyz",
          signature: "secret sk-abcdef1234567890xyz",
          thinkingSignature: "secret sk-abcdef1234567890xyz",
          thoughtSignature: "secret sk-abcdef1234567890xyz",
          thought_signature: "secret sk-abcdef1234567890xyz",
          encrypted_content: "secret sk-abcdef1234567890xyz",
          nested: {
            type: "redacted_thinking",
            data: "secret sk-abcdef1234567890xyz",
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    expect(JSON.stringify(msgContent(result))).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts partialJson block", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCallDelta", partialJson: '{"key":"sk-abcdef1234567890xyz"}' }],
    } as unknown as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ partialJson: string }>)[0],
      "(msgContent(result) as Array<{ partialJson: string }>)[0] test invariant",
    );
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
    const block = expectDefined(
      (msgContent(result) as Array<{ arguments: unknown }>)[0],
      "(msgContent(result) as Array<{ arguments: unknown }>)[0] test invariant",
    );
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
      expectDefined(
        (msgContent(msg) as Array<{ arguments: unknown }>)[0],
        "(msgContent(msg) as Array<{ arguments: unknown }>)[0] test invariant",
      ).arguments,
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
    const block = expectDefined(
      (msgContent(result) as Array<{ arguments: unknown }>)[0],
      "(msgContent(result) as Array<{ arguments: unknown }>)[0] test invariant",
    );
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
    const block = expectDefined(
      (msgContent(result) as Array<{ input: unknown }>)[0],
      "(msgContent(result) as Array<{ input: unknown }>)[0] test invariant",
    );
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
    const block = expectDefined(
      (msgContent(result) as Array<{ input: unknown }>)[0],
      "(msgContent(result) as Array<{ input: unknown }>)[0] test invariant",
    );
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
    // Redaction walks arbitrary tool payloads, so circular structures must be
    // replaced instead of recursing forever or throwing.
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
    expect(expectDefined(result.content[0], "result.content[0] test invariant").text).not.toContain(
      "sk-abcdef1234567890xyz",
    );
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

  it("preserves image data while redacting adjacent transcript text", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "my key is sk-abcdef1234567890xyz" },
        {
          type: "image",
          data: IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
          mimeType: "image/png",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const content = msgContent(result) as Array<{ type: string; text?: string; data?: string }>;
    expect(expectDefined(content[0], "content[0] test invariant").text).not.toContain(
      "sk-abcdef1234567890xyz",
    );
    expect(expectDefined(content[1], "content[1] test invariant").data).toBe(
      IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
    );
    expect(JSON.stringify(result)).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts fake image payloads that are not valid image base64", () => {
    const msg = {
      role: "user",
      content: [
        {
          type: "image",
          data: "sk-abcdef1234567890xyz",
          mimeType: "image/png",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const content = msgContent(result) as Array<{ data: string }>;
    expect(expectDefined(content[0], "content[0] test invariant").data).toBe("sk-abc…0xyz");
  });

  it("preserves valid BMP image base64 while redacting adjacent text", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "my key is sk-abcdef1234567890xyz" },
        {
          type: "image",
          data: BMP_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
          mimeType: "image/bmp",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const content = msgContent(result) as Array<{ type: string; text?: string; data?: string }>;
    expect(expectDefined(content[0], "content[0] test invariant").text).not.toContain(
      "sk-abcdef1234567890xyz",
    );
    expect(expectDefined(content[1], "content[1] test invariant").data).toBe(
      BMP_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
    );
  });

  it("preserves provider-style image base64 source data", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "gatewayCustom",
          source: {
            type: "base64",
            media_type: "image/png",
            data: IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
          },
          apiKey: "plainsecretvalue123",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ source: { data: string }; apiKey: string }>)[0],
      "(msgContent(result) as Array<{ source: { data: string }; apiKey: stri... test invariant",
    );
    expect(block.source.data).toBe(IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING);
    expect(block.apiKey).toBe("plains…e123");
  });

  it("canonicalizes preserved image MIME from sniffed base64 bytes", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "gatewayCustom",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING,
          },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ source: { data: string; media_type: string } }>)[0],
      "( msgContent(result) as Array<{ source: { data: string; media_type: s... test invariant",
    );
    expect(block.source.data).toBe(IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING);
    expect(block.source.media_type).toBe("image/png");
  });

  it("preserves image data URLs without exempting non-image data fields", () => {
    const dataUrl = `data:image/png;base64,${IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING}`;
    const msg = {
      role: "assistant",
      content: [
        {
          type: "input_image",
          image_url: dataUrl,
          data: "AKIDABCDEFGHIJKLMNOP",
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ image_url: string; data: string }>)[0],
      "(msgContent(result) as Array<{ image_url: string; data: string }>)[0] test invariant",
    );
    expect(block.image_url).toBe(dataUrl);
    expect(block.data).toBe("AKIDAB…MNOP");
  });

  it("preserves valid non-browser image data URLs in transcripts", () => {
    const dataUrl = `data:image/bmp;base64,${BMP_BASE64_WITH_SECRET_TOKEN_SUBSTRING}`;
    const msg = {
      role: "assistant",
      content: [
        {
          type: "input_image",
          image_url: dataUrl,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ image_url: string }>)[0],
      "(msgContent(result) as Array<{ image_url: string }>)[0] test invariant",
    );
    expect(block.image_url).toBe(dataUrl);
  });

  it("preserves image data URLs with metadata parameters before base64", () => {
    const dataUrl = `data:image/png;charset=utf-8;base64,${IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING}`;
    const canonicalDataUrl = `data:image/png;base64,${IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING}`;
    const msg = {
      role: "assistant",
      content: [
        {
          type: "input_image",
          image_url: dataUrl,
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ image_url: string }>)[0],
      "(msgContent(result) as Array<{ image_url: string }>)[0] test invariant",
    );
    expect(block.image_url).toBe(canonicalDataUrl);
  });

  it("preserves nested image_url data URL payloads", () => {
    const dataUrl = `data:image/png;base64,${IMAGE_BASE64_WITH_SECRET_TOKEN_SUBSTRING}`;
    const msg = {
      role: "assistant",
      content: [
        {
          type: "image_url",
          image_url: { url: dataUrl },
        },
      ],
    } as unknown as AgentMessage;

    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = expectDefined(
      (msgContent(result) as Array<{ image_url: { url: string } }>)[0],
      "(msgContent(result) as Array<{ image_url: { url: string } }>)[0] test invariant",
    );
    expect(block.image_url.url).toBe(dataUrl);
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
    const text = expectDefined(
      (msgContent(result) as Array<{ text: string }>)[0],
      "(msgContent(result) as Array<{ text: string }>)[0] test invariant",
    ).text;
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

  it("passes through signatures unchanged when global redaction is off", () => {
    const readLoggingConfig = vi
      .spyOn(loggingConfigModule, "readLoggingConfig")
      .mockReturnValue({ redactSensitive: "off" });
    const msg = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "secret sk-abcdef1234567890xyz",
          thinkingSignature: JSON.stringify({
            id: "rs_secret_identifier",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "secret sk-abcdef1234567890xyz" }],
            encrypted_content: CIPHERTEXT_WITH_TOKEN_SHAPED_BYTES,
          }),
        },
      ],
    } as unknown as AgentMessage;

    try {
      expect(redactTranscriptMessage(msg)).toBe(msg);
    } finally {
      readLoggingConfig.mockRestore();
    }
  });

  it("redacts with cfg=undefined (falls back to default patterns)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz");
    const result = redactTranscriptMessage(msg, undefined);
    const text = expectDefined(
      (msgContent(result) as Array<{ text: string }>)[0],
      "(msgContent(result) as Array<{ text: string }>)[0] test invariant",
    ).text;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
