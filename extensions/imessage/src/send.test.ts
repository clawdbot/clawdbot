// Imessage tests cover send plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import {
  sanitizeIMessageFinalOutboundText,
  sanitizeOutboundText,
} from "./monitor/sanitize-outbound.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type ApprovalReactionsModule = typeof import("./approval-reactions.js");
type PersistedEchoCacheModule = typeof import("./monitor/persisted-echo-cache.js");
type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
type SendModule = typeof import("./send.js");
let clearIMessageApprovalReactionTargetsForTest: ApprovalReactionsModule["clearIMessageApprovalReactionTargetsForTest"];
let resolveIMessageApprovalReactionTargetWithPersistence: ApprovalReactionsModule["resolveIMessageApprovalReactionTargetWithPersistence"];
let hasPersistedIMessageEcho: PersistedEchoCacheModule["hasPersistedIMessageEcho"];
let findLatestIMessageEntryForChat: ReplyCacheModule["findLatestIMessageEntryForChat"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let sendMessageIMessage: SendModule["sendMessageIMessage"];

async function loadFreshSendModule(): Promise<void> {
  ({ findLatestIMessageEntryForChat, rememberIMessageReplyCache } =
    await loadFreshIMessageReplyCacheForTest());
  ({
    clearIMessageApprovalReactionTargetsForTest,
    resolveIMessageApprovalReactionTargetWithPersistence,
  } = await import("./approval-reactions.js"));
  ({ hasPersistedIMessageEcho } = await import("./monitor/persisted-echo-cache.js"));
  ({ sendMessageIMessage } = await import("./send.js"));
}

const IMESSAGE_TEST_CFG = {
  channels: {
    imessage: {
      accounts: {
        default: {},
      },
    },
  },
};

function createClient(result: Record<string, unknown>): IMessageRpcClient {
  return {
    request: vi.fn(async () => result),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

function createRejectingClient(error: Error): IMessageRpcClient {
  return {
    request: vi.fn(async () => {
      await Promise.resolve();
      throw error;
    }),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

function getClientMocks(client: IMessageRpcClient): {
  request: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return client as unknown as {
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

function createApprovalText(id = "approval-123"): string {
  return [
    "Exec approval required",
    `ID: ${id}`,
    "",
    `Reply with: /approve ${id} allow-once|deny`,
  ].join("\n");
}

describe("sendMessageIMessage receipts", () => {
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-send-",
    });
    await loadFreshSendModule();
  });

  afterEach(async () => {
    clearIMessageApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await openClawState.cleanup();
  });

  function createOutboundMediaFile(filename: string, contents: Buffer): string {
    const sourcePath = openClawState.path(filename);
    fs.writeFileSync(sourcePath, contents);
    return sourcePath;
  }

  it("scrubs private markers before delivering fenced YAML over real iMessage RPC", async () => {
    const cliPath = openClawState.path("fake-imsg");
    const requestLogPath = openClawState.path("fake-imsg-requests.jsonl");
    const actionLogPath = openClawState.path("fake-imsg-actions.jsonl");
    fs.writeFileSync(
      cliPath,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "const requestLogPath = " + JSON.stringify(requestLogPath) + ";",
        "const actionLogPath = " + JSON.stringify(actionLogPath) + ";",
        "const args = process.argv.slice(2);",
        'if (args.join(" ") === "rpc --json") {',
        '  readline.createInterface({ input: process.stdin }).on("line", (line) => {',
        "    const request = JSON.parse(line);",
        '    fs.appendFileSync(requestLogPath, line + "\\n");',
        "    process.stdout.write(JSON.stringify({",
        '      jsonrpc: "2.0", id: request.id,',
        '      result: { guid: "p:0/imsg-rpc-proof", status: "sent" }',
        '    }) + "\\n");',
        "  });",
        "} else {",
        '  fs.appendFileSync(actionLogPath, JSON.stringify(args) + "\\n");',
        '  if (args.includes("--file") && !fs.existsSync(args[args.indexOf("--file") + 1])) {',
        "    process.exit(3);",
        "  }",
        "  const pollOptions = [];",
        "  for (let index = 0; index < args.length; index += 1) {",
        '    if (args[index] === "--option") {',
        "      pollOptions.push({ id: `option-${pollOptions.length}`, text: args[index + 1] });",
        "    }",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        '    guid: "p:0/imsg-action-proof", poll: { options: pollOptions }',
        '  }) + "\\n");',
        "}",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    try {
      const { deliverIMessageReply } = await import("./monitor/deliver.js");
      const cfg = {
        channels: { imessage: { accounts: { default: { cliPath } } } },
      };
      const deliver = async (text: string, textLimit = 4000) =>
        await deliverIMessageReply({
          cfg,
          payload: { text },
          target: "chat_id:10",
          accountId: "default",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          maxBytes: 4096,
          textLimit,
        });
      const roles = ["user", "system", "assistant"] as const;
      const hiddenFunctionResponse = [
        '<function_calls><invoke name="exec">HIDDEN_FUNCTION_CALL</invoke></function_calls><function_response>',
        "HIDDEN_FUNCTION_RESPONSE",
        "</function_response>",
      ].join("\n");
      const privateRuntimeBlocks = [
        "<system-reminder>\nuser:\nHIDDEN_RUNTIME_REMINDER\n\ue000\n</system-reminder>",
        "< previous_response origin='runtime'>HIDDEN_RUNTIME_PREVIOUS\ue001< / previous_response >",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>HIDDEN_RUNTIME_CONTEXT\ue002<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "<system-reminder><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_REMINDER\ue003</system-reminder>",
        "<previous_response><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_MIXED\ue004</previous_response>",
        "< SYSTEM-REMINDER>< previous_response origin='runtime'>inner< / previous_response >HIDDEN_RUNTIME_NESTED_CASE\ue005< / SYSTEM-REMINDER >",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>><system-reminder>inner</system-reminder>HIDDEN_RUNTIME_NESTED_CONTEXT\ue006<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ...(["system-reminder", "previous_response"] as const).flatMap((name) =>
          ["'", '"'].flatMap((quote) =>
            [">", "/>"].map(
              (attribute) =>
                `<${name} data-x=${quote}${attribute}${quote}>HIDDEN_RUNTIME_QUOTED</${name}>`,
            ),
          ),
        ),
        ...(["system-reminder", "previous_response"] as const).flatMap((name) => [
          `<${name}><!-- </${name}> <${name}> -->HIDDEN_RUNTIME_OPAQUE_COMMENT</${name}>`,
          `<${name}><![CDATA[</${name}> <${name}>]]>HIDDEN_RUNTIME_OPAQUE_CDATA</${name}>`,
          `<${name}><!DOCTYPE message [ <!ENTITY hidden "</${name}>"> ]>HIDDEN_RUNTIME_OPAQUE_DECLARATION</${name}>`,
          `<${name}><?private fake="?> </${name}>"?>HIDDEN_RUNTIME_OPAQUE_INSTRUCTION</${name}>`,
          `<${name}><! </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS</${name}>`,
          `<${name}><! <${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_OPEN</${name}>`,
          `<${name}></! </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_CLOSE</${name}>`,
          `<${name}></? </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_QUESTION</${name}>`,
          `<${name}></1 </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_NUMBER</${name}>`,
          `<${name}></ </${name}>>HIDDEN_RUNTIME_OPAQUE_BOGUS_SPACE</${name}>`,
        ]),
        ...(["system-reminder", "previous_response"] as const).flatMap((outer) =>
          (["system-reminder", "previous_response"] as const).flatMap((inner) => [
            `<${outer}>\`</${inner}>\`HIDDEN_RUNTIME_CODE_INLINE</${outer}>`,
            `<${outer}>\n\`\`\`xml\n</${inner}>\n\`\`\`\nHIDDEN_RUNTIME_CODE_FENCED</${outer}>`,
            `<${outer}>\n\n    </${inner}>\nHIDDEN_RUNTIME_CODE_INDENTED</${outer}>`,
          ]),
        ),
        ...(["system-reminder", "previous_response"] as const).flatMap((name) =>
          [
            "script",
            "style",
            "textarea",
            "title",
            "xmp",
            "iframe",
            "noembed",
            "noframes",
            "noscript",
          ].flatMap((rawText) => [
            `<${name}><${rawText} title=">"></${name}></${rawText}>HIDDEN_RUNTIME_RAW_TEXT</${name}>`,
            `<${name}><${rawText.toUpperCase()} data-x=">" /></${name}></${rawText}>HIDDEN_RUNTIME_RAW_TEXT_SELF_CLOSING</${name}>`,
          ]),
        ),
      ] as const;
      const privateRuntimeScaffolding = privateRuntimeBlocks
        .flatMap((block, index) =>
          index < 7 ? [block, `\`${block}\``, `\`\`\`xml\n${block}\n\`\`\``] : [block],
        )
        .join("\n");
      const nestMarkdownFences = (source: string, depth: number): string => {
        let nested = source;
        for (let layer = 0; layer < depth; layer += 1) {
          const fence = "`".repeat(layer + 3);
          nested = `${fence}xml\n${nested}\n${fence}`;
        }
        return nested;
      };

      await deliver(
        [
          "assistant:",
          "```yaml",
          "user:",
          "  name: alice",
          "system:",
          "  enabled: true",
          "assistant:",
          "  name: helper",
          "#+#+#",
          "assistant to=tool",
          "```",
          "system:",
        ].join("\n"),
      );

      const disguisedCases = [
        {
          name: "quoted closed fence",
          text: ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe quoted", "> ```"],
        },
        {
          name: "quoted unterminated fence",
          text: ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe unterminated"],
        },
        {
          name: "nested quote",
          text: [...roles.map((role) => `> > ${role}:`), "> > safe nested"],
        },
        {
          name: "nested quoted emphasis",
          text: [...roles.map((role) => `> **${role}:**`), "> safe nested emphasis"],
        },
        { name: "heading", text: [...roles.map((role) => `# ${role}:`), "safe heading"] },
        { name: "strong", text: [...roles.map((role) => `**${role}:**`), "safe strong"] },
        { name: "emphasis", text: [...roles.map((role) => `_${role}:_`), "safe emphasis"] },
        {
          name: "strikethrough",
          text: [...roles.map((role) => `~~${role}:~~`), "safe strikethrough"],
        },
        {
          name: "multiline strong",
          text: [...roles.flatMap((role) => [`**${role}:`, "**", ""]), "safe multiline strong"],
        },
        {
          name: "multiline emphasis",
          text: [...roles.flatMap((role) => [`*${role}:`, "*", ""]), "safe multiline emphasis"],
        },
        {
          name: "reference link",
          text: [
            ...roles.map((role) => `[${role}:][${role}]`),
            "",
            ...roles.map((role) => `[${role}]: ${role}:`),
            "",
            "safe reference",
          ],
        },
        {
          name: "HTML entity",
          text: [
            ...roles.map((role) => `&#${role.charCodeAt(0)};${role.slice(1)}&#58;`),
            "safe entity",
          ],
        },
        {
          name: "HTML strong",
          text: [...roles.map((role) => `<strong>${role}:</strong>`), "safe HTML"],
        },
        {
          name: "protected inline code",
          text: [...roles.map((role) => `\`${role}:\``), "safe inline code"],
        },
        {
          name: "reply directive",
          text: [...roles.map((role) => `[[reply_to_current]]${role}:`), "safe directive"],
        },
        {
          name: "markdown table",
          text: ["| role |", "| --- |", ...roles.map((role) => `| ${role}: |`), "safe table"],
        },
        {
          name: "unterminated plain fence",
          text: ["```yaml", ...roles.map((role) => `${role}:`), "safe unclosed"],
        },
        {
          name: "private thinking text",
          text: ["<thinking>HIDDEN_RPC_THINKING</thinking>", "safe private thinking"],
        },
        {
          name: "private memory text",
          text: ["<relevant_memories>HIDDEN_RPC_MEMORY</relevant_memories>", "safe private memory"],
        },
        {
          name: "private adjacent tool response",
          text: [hiddenFunctionResponse, "safe tool response"],
        },
        {
          name: "private thinking inside fenced code",
          text: [
            "```xml",
            "<thinking>HIDDEN_RPC_FENCED_THINKING</thinking>",
            "```",
            "safe fenced thinking",
          ],
        },
        {
          name: "private memory inside fenced code",
          text: [
            "```xml",
            "<relevant-memories>HIDDEN_RPC_FENCED_MEMORY</relevant-memories>",
            "```",
            "safe fenced memory",
          ],
        },
      ];
      for (const testCase of disguisedCases) {
        await deliver(testCase.text.join("\n"));
      }

      await sendMessageIMessage(
        "chat_id:10",
        ["# assistant:", "**😀 styled**", "#+#+#", "assistant to=tool"].join("\n"),
        { config: cfg },
      );

      const { imessagePlugin } = await import("./channel.js");
      const channelChunker = imessagePlugin.outbound?.chunker;
      const channelSanitizer = imessagePlugin.outbound?.sanitizeText;
      if (!channelChunker || !channelSanitizer) {
        throw new Error("Expected the iMessage outbound Markdown sanitizer and chunker");
      }
      expect(imessagePlugin.outbound?.chunkerMode).toBe("markdown");

      const countNativeRequests = () =>
        fs.readFileSync(requestLogPath, "utf8").trim().split("\n").length;
      const deliverThroughChannel = async (source: string, limit = 4000) => {
        const sanitized = channelSanitizer({ text: source, payload: { text: source } });
        const chunks = channelChunker(sanitized, limit);
        for (const chunk of chunks) {
          await sendMessageIMessage("chat_id:10", chunk, { config: cfg });
        }
        return { sanitized, chunks };
      };

      const channelYaml = ["```yaml", ...roles.map((role) => `${role}:`), "```"].join("\n");
      const channelYamlResult = await deliverThroughChannel(channelYaml);
      expect(channelYamlResult.sanitized).toContain("```yaml");
      const channelYamlRequest = JSON.parse(
        fs.readFileSync(requestLogPath, "utf8").trim().split("\n").at(-1) ?? "{}",
      ) as { params?: { text?: string } };
      for (const role of roles) {
        expect(channelYamlRequest.params?.text).toMatch(new RegExp(`^${role}:$`, "m"));
      }

      let channelContractRequestCount = 1;
      for (const [html, bold, strike] of [
        [
          `<strong title="b>">😀 channel bold</strong> <del data-note='s>'>channel strike</del>`,
          "😀 channel bold",
          "channel strike",
        ],
        [
          `<strong title="<tag>">😀 quoted bold</strong> <del data-note='<tag>'>quoted strike</del>`,
          "😀 quoted bold",
          "quoted strike",
        ],
        [
          `<strong title="<previous_response>">😀 private-looking bold</strong> <del data-note='<system-reminder>'>private-looking strike</del>`,
          "😀 private-looking bold",
          "private-looking strike",
        ],
        [
          `<strong title="<!--">😀 opaque-looking bold</strong> <del data-note='<?'>opaque-looking strike</del>`,
          "😀 opaque-looking bold",
          "opaque-looking strike",
        ],
      ] as const) {
        const attributedHtml = await deliverThroughChannel(html);
        expect(attributedHtml.sanitized).toBe(`**${bold}** ~~${strike}~~`);
        const attributedRequest = JSON.parse(
          fs.readFileSync(requestLogPath, "utf8").trim().split("\n").at(-1) ?? "{}",
        ) as {
          params?: {
            text: string;
            formatting?: Array<{ start: number; length: number; styles: string[] }>;
          };
        };
        for (const [style, expected] of [
          ["bold", bold],
          ["strikethrough", strike],
        ] as const) {
          const range = attributedRequest.params?.formatting?.find((item) =>
            item.styles.includes(style),
          );
          expect(
            attributedRequest.params?.text.slice(
              range?.start,
              (range?.start ?? 0) + (range?.length ?? 0),
            ),
          ).toBe(expected);
        }
        channelContractRequestCount += attributedHtml.chunks.length;
      }

      for (const source of [
        "if(a<b && c<d)",
        "std::vector<std::vector<int>>",
        "t<int>",
        "```cpp\nif(a<b && c<d)\nstd::vector<std::vector<int>>\n```",
        "ordinary <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> marker mention",
        "ordinary <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>opaque prose<<<END_OPENCLAW_INTERNAL_CONTEXT>>> remains safe",
      ]) {
        // Unknown generic tags already follow the shared renderer's shipped stripping semantics.
        const baseline = sanitizeForPlainText(sanitizeOutboundText(source), { style: "markdown" });
        const delivered = await deliverThroughChannel(source);
        expect(delivered.sanitized).toBe(baseline);
        const request = JSON.parse(
          fs.readFileSync(requestLogPath, "utf8").trim().split("\n").at(-1) ?? "{}",
        ) as { params?: { text?: string } };
        expect(request.params?.text).toBe(
          sanitizeIMessageFinalOutboundText(baseline, { formatMarkdown: true }).text,
        );
        channelContractRequestCount += delivered.chunks.length;
      }

      const runtimeCompanion = `${privateRuntimeScaffolding}\nvisible runtime companion`;
      for (const sendPrivateRuntime of [
        () => sendMessageIMessage("chat_id:10", runtimeCompanion, { config: cfg }),
        () => deliver(runtimeCompanion),
        () => deliverThroughChannel(runtimeCompanion),
      ]) {
        const previousRequestCount = countNativeRequests();
        await sendPrivateRuntime();
        const runtimeRequests = fs
          .readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .slice(previousRequestCount)
          .map((line) => JSON.parse(line) as { params?: { text?: string } });
        expect(runtimeRequests.length).toBeGreaterThan(0);
        expect(
          runtimeRequests.some((request) =>
            request.params?.text?.includes("visible runtime companion"),
          ),
        ).toBe(true);
        for (const request of runtimeRequests) {
          expect(request.params?.text).not.toContain("HIDDEN_RUNTIME_");
          expect(request.params?.text).not.toMatch(
            /system-reminder|previous_response|INTERNAL_CONTEXT/i,
          );
        }
        channelContractRequestCount += runtimeRequests.length;
      }

      for (const hidden of [
        "```xml\n<thinking>HIDDEN_CHANNEL_FENCED_THINKING</thinking>\n```",
        "`<thinking>HIDDEN_CHANNEL_INLINE_THINKING</thinking>`",
        "```xml\n<relevant_memories>HIDDEN_CHANNEL_FENCED_MEMORY</relevant_memories>\n```",
        "`<relevant-memories>HIDDEN_CHANNEL_INLINE_MEMORY</relevant-memories>`",
        nestMarkdownFences("<thinking>HIDDEN_CHANNEL_DEEPLY_NESTED_THINKING</thinking>", 4),
        nestMarkdownFences(
          "<relevant_memories>HIDDEN_CHANNEL_DEEPLY_NESTED_MEMORY</relevant_memories>",
          4,
        ),
        `\`\`\`xml\n${hiddenFunctionResponse}\n\`\`\``,
        nestMarkdownFences(hiddenFunctionResponse, 4),
      ]) {
        const requestCount = countNativeRequests();
        await expect(deliverThroughChannel(`${hidden}\nsafe channel text`)).rejects.toThrow(
          "iMessage outbound hidden assistant content is not allowed",
        );
        expect(countNativeRequests()).toBe(requestCount);
      }
      const malformedHiddenFunctionResponse = [
        '<<script>function_calls><<script>invoke name="exec">HIDDEN_CHANNEL_SYNTH_FUNCTION_CALL</<script>invoke></<script>function_calls><<script>function_response>',
        "HIDDEN_CHANNEL_SYNTH_FUNCTION_RESPONSE",
        "</<script>function_response>",
      ].join("\n");
      for (const malformed of [
        "<<script>thinking>HIDDEN_CHANNEL_SYNTH_THINKING</<script>thinking>",
        "<t<script>hinking>HIDDEN_CHANNEL_INNER_THINKING</t<script>hinking>",
        "<<script>relevant_memories>HIDDEN_CHANNEL_SYNTH_MEMORY</<script>relevant_memories>",
        "<<script>relevant-memories>HIDDEN_CHANNEL_SYNTH_HYPHEN_MEMORY</<script>relevant-memories>",
        "<thi<system-reminder>noise</system-reminder>nking>HIDDEN_CHANNEL_REMINDER_THINKING</thi<system-reminder>noise</system-reminder>nking>",
        "<relevant_<previous_response>noise</previous_response>memories>HIDDEN_CHANNEL_PREVIOUS_MEMORY</relevant_<previous_response>noise</previous_response>memories>",
        "<thi<details><summary>noise</summary></details>nking>HIDDEN_CHANNEL_DETAILS_THINKING</thi<details>nking>",
        malformedHiddenFunctionResponse,
      ]) {
        const requestCount = countNativeRequests();
        await expect(deliverThroughChannel(`${malformed}\nsafe channel text`)).rejects.toThrow(
          "iMessage outbound ambiguous nested HTML is not allowed",
        );
        expect(countNativeRequests()).toBe(requestCount);
      }
      for (const [context, splice] of [
        ["script", "<script>"],
        ["system-reminder", "<system-reminder>noise</system-reminder>"],
        ["spaced_system_reminder", "< system-reminder>noise< / system-reminder>"],
        ["previous_response", "<previous_response>noise</previous_response>"],
        ["spaced_previous_response", "< previous_response>noise< / previous_response>"],
        ["details", "<details><summary>noise</summary></details>"],
        ["spaced_details", "< details>< summary>noise< / summary>< / details>"],
        [
          "runtime_context",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ],
      ] as const) {
        for (const [kind, malformed] of [
          ["thinking", `<thi${splice}nking>HIDDEN_CHANNEL_${context}_THINKING</thi${splice}nking>`],
          [
            "underscore memory",
            `<relevant_${splice}memories>HIDDEN_CHANNEL_${context}_MEMORY</relevant_${splice}memories>`,
          ],
          [
            "hyphen memory",
            `<relevant-${splice}memories>HIDDEN_CHANNEL_${context}_MEMORY</relevant-${splice}memories>`,
          ],
          [
            "tool response",
            [
              `<function_${splice}calls><invoke>HIDDEN_CHANNEL_${context}_CALL</invoke></function_${splice}calls>`,
              `<function_${splice}response>HIDDEN_CHANNEL_${context}_RESPONSE</function_${splice}response>`,
            ].join("\n"),
          ],
        ] as const) {
          for (const wrapper of [
            malformed,
            `\`${malformed}\``,
            `\`\`\`xml\n${malformed}\n\`\`\``,
          ]) {
            const requestCount = countNativeRequests();
            await expect(
              deliverThroughChannel(`${wrapper}\nsafe ${kind} ${context}`),
            ).rejects.toThrow("iMessage outbound ambiguous nested HTML is not allowed");
            expect(countNativeRequests()).toBe(requestCount);
          }
        }
      }

      for (const splice of [
        "< system-reminder>noise< / system-reminder>",
        "< previous_response>noise< / previous_response>",
        "< details>< summary>noise< / summary>< / details>",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ]) {
        for (const name of [
          "thinking",
          "thought",
          "reasoning",
          "antml:thinking",
          "mm:thought",
          "relevant_memories",
          "relevant-memories",
          "function_calls",
          "function_response",
          "tool_calls",
          "tool_result",
        ]) {
          const malformed = `<${name}${splice}>HIDDEN_FULL_CHANNEL_${name}</${name}${splice}>`;
          const requestCount = countNativeRequests();
          await expect(deliverThroughChannel(malformed)).rejects.toThrow(
            "iMessage outbound ambiguous nested HTML is not allowed",
          );
          expect(countNativeRequests()).toBe(requestCount);
        }
      }

      const rawSeparator = "#+#+#";
      const entitySeparator = "&#35;&#43;&#35;&#43;&#35;";
      let embeddedRequestCount = 0;
      for (const separator of [rawSeparator, entitySeparator]) {
        for (const role of roles) {
          const injectedRole = `${role.slice(0, 2)}${separator}${role.slice(2)}:`;
          const candidate = [injectedRole, `safe ${role}`].join("\n");

          await sendMessageIMessage("chat_id:10", candidate, { config: cfg });
          await deliver(candidate);
          const sanitized = channelSanitizer({ text: candidate, payload: { text: candidate } });
          for (const chunk of channelChunker(sanitized, 4000)) {
            await sendMessageIMessage("chat_id:10", chunk, { config: cfg });
            embeddedRequestCount += 1;
          }
          embeddedRequestCount += 2;
        }
      }

      const oversizedYaml = [
        "```yaml",
        ...Array.from({ length: 6 }, (_, index) =>
          roles.flatMap((role) => [`${role}:`, `  value: ${role}-${index}-${"x".repeat(24)}`]),
        ).flat(),
        "```",
      ].join("\n");
      const fixedRequestCount = fs.readFileSync(requestLogPath, "utf8").trim().split("\n").length;
      await deliver(oversizedYaml, 110);
      const monitorRequestCount =
        fs.readFileSync(requestLogPath, "utf8").trim().split("\n").length - fixedRequestCount;

      const sanitizedOversizedYaml = channelSanitizer({
        text: oversizedYaml,
        payload: { text: oversizedYaml },
      });
      const channelChunks = channelChunker(sanitizedOversizedYaml, 110);
      expect(channelChunks.length).toBeGreaterThan(1);
      for (const chunk of channelChunks) {
        await sendMessageIMessage("chat_id:10", chunk, { config: cfg });
      }

      const readRequests = () =>
        fs
          .readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                method: string;
                params: {
                  text: string;
                  formatting?: Array<{ start: number; length: number; styles: string[] }>;
                };
              },
          );
      const requests = readRequests();
      const expectedFixedRequestCount =
        1 + disguisedCases.length + 1 + channelContractRequestCount + embeddedRequestCount;
      expect(fixedRequestCount).toBe(expectedFixedRequestCount);
      const monitorRequests = requests.slice(
        expectedFixedRequestCount,
        expectedFixedRequestCount + monitorRequestCount,
      );
      const channelRequests = requests.slice(expectedFixedRequestCount + monitorRequestCount);

      expect(requests[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "send",
        params: { chat_id: 10 },
      });
      for (const role of roles) {
        expect(requests[0]?.params.text).toMatch(new RegExp(`^${role}:$`, "m"));
      }
      for (const chunkRequests of [monitorRequests, channelRequests]) {
        expect(chunkRequests.length).toBeGreaterThan(1);
        for (const role of roles) {
          expect(
            chunkRequests.some((request) =>
              new RegExp(`^${role}:$`, "m").test(request.params.text),
            ),
          ).toBe(true);
        }
      }
      const channelYamlRequestIndex = 1 + disguisedCases.length + 1;
      for (const [index, request] of requests.slice(1, expectedFixedRequestCount).entries()) {
        // This channel request is authenticated closed-fence YAML, not leaked prose role headers.
        if (index + 1 !== channelYamlRequestIndex) {
          expect(request.params.text).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
        }
      }
      for (const request of requests) {
        expect(request.params.text).not.toContain("#+#+#");
        expect(request.params.text).not.toContain("HIDDEN_RPC_");
        expect(request.params.text).not.toContain("HIDDEN_FUNCTION_");
        expect(request.params.text).not.toContain("HIDDEN_RUNTIME_");
        expect(request.params.text).not.toMatch(
          /system-reminder|previous_response|INTERNAL_CONTEXT/i,
        );
        expect(request.params.text).not.toMatch(/<(?:thinking|relevant[-_]memories)\b/i);
        expect(request.params.text).not.toMatch(/assistant\s+to\s*=\s*\w+/i);
        expect(request.params.text).not.toMatch(/[\ue000-\uf8ff]/);
        for (const range of request.params.formatting ?? []) {
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.start + range.length).toBeLessThanOrEqual(request.params.text.length);
        }
      }
      const styled = requests[1 + disguisedCases.length];
      const boldRange = styled?.params.formatting?.find((range) => range.styles.includes("bold"));
      expect(
        styled?.params.text.slice(
          boldRange?.start,
          (boldRange?.start ?? 0) + (boldRange?.length ?? 0),
        ),
      ).toBe("😀 styled");

      const { imessageActionsRuntime } = await import("./actions.runtime.js");
      const actionOptions = { cliPath, chatGuid: "iMessage;+;chat0000" };
      const fencedYaml = ["```yaml", ...roles.map((role) => `${role}:`), "```"].join("\n");
      await imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: [
          "# user:",
          "**system:**",
          "&#97;ssistant&#58;",
          `us${rawSeparator}er:`,
          "<thinking>HIDDEN_ACTION_REPLY_THINKING</thinking>",
          hiddenFunctionResponse,
          privateRuntimeScaffolding,
          "**😀 reply styled**",
          "assistant to=tool",
        ].join("\n"),
        replyToMessageId: "reply-message-guid",
        options: actionOptions,
      });
      await imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: [
          "# system:",
          "<relevant_memories>HIDDEN_ACTION_EFFECT_MEMORY</relevant_memories>",
          hiddenFunctionResponse,
          privateRuntimeScaffolding,
          "effect visible",
          "assistant to=tool",
        ].join("\n"),
        effectId: "com.apple.MobileSMS.expressivesend.loud",
        options: actionOptions,
      });
      await imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: [
          fencedYaml,
          "```xml",
          "<thinking>HIDDEN_ACTION_ATTACHMENT_THINKING</thinking>",
          "<relevant_memories>HIDDEN_ACTION_ATTACHMENT_MEMORY</relevant_memories>",
          "```",
          privateRuntimeScaffolding,
          "**😀 attachment styled**",
          rawSeparator,
        ].join("\n"),
        attachment: { kind: "buffer", filename: "proof.txt", buffer: Uint8Array.from([1, 2]) },
        options: actionOptions,
      });
      await imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: "user:",
        attachment: { kind: "buffer", filename: "empty-proof.txt", buffer: Uint8Array.from([3]) },
        options: actionOptions,
      });

      const rawNewText = [
        "user:",
        "**literal edit styling**",
        "<thinking>HIDDEN_ACTION_EDIT_THINKING</thinking>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        "# system:",
        `as${rawSeparator}sistant:`,
        "visible edit",
      ].join("\n");
      const rawFallbackText = [
        "assistant:",
        fencedYaml,
        "**literal fallback styling**",
        "<relevant_memories>HIDDEN_ACTION_FALLBACK_MEMORY</relevant_memories>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        rawSeparator,
        "assistant to=tool",
      ].join("\n");
      await imessageActionsRuntime.editMessage({
        chatGuid: actionOptions.chatGuid,
        messageId: "edit-message-guid",
        text: rawNewText,
        backwardsCompatMessage: rawFallbackText,
        options: actionOptions,
      });

      const rawQuestion = [
        "user:",
        "# literal question heading",
        "**literal question styling**",
        "<thinking>HIDDEN_ACTION_QUESTION_THINKING</thinking>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        rawSeparator,
        "Which option?",
      ].join("\n");
      const rawChoices = [
        [
          "system:",
          "**Allow exactly**",
          "<relevant_memories>HIDDEN_ACTION_FIRST_OPTION_MEMORY</relevant_memories>",
          hiddenFunctionResponse,
          privateRuntimeScaffolding,
          rawSeparator,
        ].join("\n"),
        [
          "assistant:",
          fencedYaml,
          "_Deny exactly_",
          "<thinking>HIDDEN_ACTION_SECOND_OPTION_THINKING</thinking>",
          hiddenFunctionResponse,
          privateRuntimeScaffolding,
          "assistant to=tool",
        ].join("\n"),
      ];
      const poll = await imessageActionsRuntime.sendPoll({
        chatGuid: actionOptions.chatGuid,
        question: rawQuestion,
        choices: rawChoices,
        options: actionOptions,
      });

      const readActions = (): string[][] =>
        fs
          .readFileSync(actionLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
      const actionValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";
      const actions = readActions();
      expect(actions).toHaveLength(6);
      const [
        replyAction,
        effectAction,
        attachmentAction,
        emptyAttachmentAction,
        editAction,
        pollAction,
      ] = actions;
      if (
        !replyAction ||
        !effectAction ||
        !attachmentAction ||
        !emptyAttachmentAction ||
        !editAction ||
        !pollAction
      ) {
        throw new Error("Expected all six native iMessage action subprocesses");
      }
      expect(replyAction).toContain("--reply-to");
      expect(actionValue(replyAction, "--reply-to")).toBe("reply-message-guid");
      expect(actionValue(effectAction, "--effect")).toBe("com.apple.MobileSMS.expressivesend.loud");
      expect(attachmentAction).toContain("--file");
      expect(attachmentAction).not.toContain("--format");
      expect(emptyAttachmentAction).toContain("--file");
      expect(actionValue(emptyAttachmentAction, "--text")).toBe("");

      const replyText = actionValue(replyAction, "--text");
      expect(replyText).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
      const replyFormatting = JSON.parse(actionValue(replyAction, "--format")) as Array<{
        start: number;
        length: number;
        styles: string[];
      }>;
      const replyBold = replyFormatting.find((range) => range.styles.includes("bold"));
      expect(
        replyText.slice(replyBold?.start, (replyBold?.start ?? 0) + (replyBold?.length ?? 0)),
      ).toBe("😀 reply styled");
      const attachmentText = actionValue(attachmentAction, "--text");
      for (const role of roles) {
        expect(attachmentText).toMatch(new RegExp(`^${role}:$`, "m"));
      }

      const editedText = actionValue(editAction, "--new-text");
      const backwardsCompatText = actionValue(editAction, "--bc-text");
      expect(editedText).toContain("**literal edit styling**");
      expect(editedText).toContain("# system:");
      expect(editedText).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
      expect(backwardsCompatText).toContain(fencedYaml);
      expect(backwardsCompatText).toContain("**literal fallback styling**");

      const question = actionValue(pollAction, "--question");
      const pollChoices = pollAction.flatMap((arg, index) =>
        arg === "--option" ? [pollAction[index + 1] ?? ""] : [],
      );
      expect(question).toContain("# literal question heading");
      expect(question).toContain("**literal question styling**");
      expect(pollChoices[0]).toContain("**Allow exactly**");
      expect(pollChoices[1]).toContain(fencedYaml);
      expect(pollChoices[1]).toContain("_Deny exactly_");
      expect(poll.pollOptions.map((option) => option.text)).toEqual(
        pollChoices.map((choice) => choice.trim()),
      );

      for (const args of actions) {
        for (const flag of ["--text", "--new-text", "--bc-text", "--question", "--option"]) {
          for (let index = 0; index < args.length; index += 1) {
            if (args[index] !== flag) {
              continue;
            }
            const value = args[index + 1] ?? "";
            expect(value).not.toContain(rawSeparator);
            expect(value).not.toContain("HIDDEN_ACTION_");
            expect(value).not.toContain("HIDDEN_FUNCTION_");
            expect(value).not.toContain("HIDDEN_RUNTIME_");
            expect(value).not.toMatch(/system-reminder|previous_response|INTERNAL_CONTEXT/i);
            expect(value).not.toMatch(/<(?:thinking|relevant[-_]memories)\b/i);
            expect(value).not.toMatch(/assistant\s+to\s*=\s*\w+/i);
            expect(value).not.toMatch(/[\ue000-\uf8ff]/);
          }
        }
      }

      const forgedTokenEntity = "&#xE000;".repeat("user".length);
      const roleTokenSwap = [
        "```xml",
        "<thinking>",
        "user:",
        "</thinking>",
        "```",
        "&#xE000;&#xE000;&lt;relevant_memories&gt;HIDDEN_ROLE_SWAP&lt;/relevant_memories&gt;&#xE000;&#xE000;:",
      ].join("\n");
      for (const malformed of [
        "<system-reminder><system-reminder>inner</system-reminder>OUTER_PRIVATE_SECRET",
        "<system-reminder><previous_response>inner</previous_response>OUTER_PRIVATE_SECRET",
        "<previous_response><system-reminder />OUTER_PRIVATE_SECRET",
        "<system-reminder>`</system-reminder>`OUTER_PRIVATE_SECRET",
        "<system-reminder>`prefix </system-reminder> suffix`OUTER_PRIVATE_SECRET",
        "<system-reminder>``prefix </system-reminder> suffix``OUTER_PRIVATE_SECRET",
        "<system-reminder>`prefix </previous_response> suffix`OUTER_PRIVATE_SECRET",
        "<previous_response>```xml\n</system-reminder>\n```\nOUTER_PRIVATE_SECRET",
        "<system-reminder><plaintext></system-reminder>OUTER_PRIVATE_SECRET",
        "<previous_response><plaintext></previous_response>OUTER_PRIVATE_SECRET",
        "<system-reminder><PLAINTEXT /></system-reminder>OUTER_PRIVATE_SECRET",
        "<previous_response><PLAINTEXT /></previous_response>OUTER_PRIVATE_SECRET",
        "<system-reminder data-x=<previous_response>>OUTER_PRIVATE_SECRET",
        "<system-reminder <previous_response>>OUTER_PRIVATE_SECRET",
        "<previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
        "</previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
      ]) {
        for (const [wrapper, source] of [
          ["raw", malformed],
          ["inline", `\`${malformed}\``],
          ["fenced", `\`\`\`xml\n${malformed}\n\`\`\``],
          ["wide-fenced", `\`\`\`\`xml\n${malformed}\n\`\`\`\``],
        ] as const) {
          const previousActionCount = readActions().length;
          const previousRequestCount = readRequests().length;
          for (const [route, sendMalformed] of [
            ["rpc", () => sendMessageIMessage("chat_id:10", source, { config: cfg })],
            ["monitor", () => deliver(source)],
            ["channel", () => deliverThroughChannel(source)],
            [
              "rich",
              () =>
                imessageActionsRuntime.sendRichMessage({
                  chatGuid: actionOptions.chatGuid,
                  text: source,
                  options: actionOptions,
                }),
            ],
            [
              "edit",
              () =>
                imessageActionsRuntime.editMessage({
                  chatGuid: actionOptions.chatGuid,
                  messageId: "edit-message-guid",
                  text: source,
                  backwardsCompatMessage: "visible fallback",
                  options: actionOptions,
                }),
            ],
            [
              "edit-fallback",
              () =>
                imessageActionsRuntime.editMessage({
                  chatGuid: actionOptions.chatGuid,
                  messageId: "edit-message-guid",
                  text: "visible edit",
                  backwardsCompatMessage: source,
                  options: actionOptions,
                }),
            ],
            [
              "poll-question",
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: source,
                  choices: ["first", "second"],
                  options: actionOptions,
                }),
            ],
            [
              "poll-first-option",
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: "visible question",
                  choices: [source, "second"],
                  options: actionOptions,
                }),
            ],
            [
              "poll-second-option",
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: "visible question",
                  choices: ["first", source],
                  options: actionOptions,
                }),
            ],
          ] as const) {
            await expect(
              sendMalformed(),
              JSON.stringify({ malformed, wrapper, route }),
            ).rejects.toThrow("iMessage outbound runtime scaffolding is malformed");
          }
          expect(readActions()).toHaveLength(previousActionCount);
          expect(readRequests()).toHaveLength(previousRequestCount);
        }
      }
      for (const hidden of privateRuntimeBlocks) {
        const previousActionCount = readActions().length;
        const previousRequestCount = readRequests().length;
        await expect(sendMessageIMessage("chat_id:10", hidden, { config: cfg })).rejects.toThrow(
          "iMessage send requires text or media",
        );
        await expect(
          imessageActionsRuntime.sendRichMessage({
            chatGuid: actionOptions.chatGuid,
            text: hidden,
            options: actionOptions,
          }),
        ).rejects.toThrow("iMessage rich send requires text or an attachment after sanitization");
        for (const [text, backwardsCompatMessage] of [
          [hidden, "visible fallback"],
          ["visible edit", hidden],
        ] as const) {
          await expect(
            imessageActionsRuntime.editMessage({
              chatGuid: actionOptions.chatGuid,
              messageId: "edit-message-guid",
              text,
              backwardsCompatMessage,
              options: actionOptions,
            }),
          ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
        }
        for (const [questionText, choices] of [
          [hidden, ["first", "second"]],
          ["visible question", [hidden, "second"]],
          ["visible question", ["first", hidden]],
        ] as const) {
          await expect(
            imessageActionsRuntime.sendPoll({
              chatGuid: actionOptions.chatGuid,
              question: questionText,
              choices,
              options: actionOptions,
            }),
          ).rejects.toThrow(
            "iMessage poll requires a non-empty question and options after sanitization",
          );
        }
        expect(readActions()).toHaveLength(previousActionCount);
        expect(readRequests()).toHaveLength(previousRequestCount);
      }
      await expect(sendMessageIMessage("chat_id:10", "# user:", { config: cfg })).rejects.toThrow(
        "iMessage send requires text or media",
      );
      await expect(
        sendMessageIMessage(
          "chat_id:10",
          ["```yaml", "user:", "```", forgedTokenEntity].join("\n"),
          { config: cfg },
        ),
      ).rejects.toThrow("iMessage outbound role protection failed");
      const splitForgedToken = "&#xE000;&#xE000;" + entitySeparator + "&#xE000;&#xE000;";
      await expect(
        sendMessageIMessage(
          "chat_id:10",
          ["```yaml", "user:", "```", splitForgedToken].join("\n"),
          { config: cfg },
        ),
      ).rejects.toThrow("iMessage outbound role protection failed");
      await expect(
        sendMessageIMessage("chat_id:10", "`<thinking>HIDDEN_RPC_INLINE_THINKING</thinking>`", {
          config: cfg,
        }),
      ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
      await expect(
        sendMessageIMessage("chat_id:10", roleTokenSwap, { config: cfg }),
      ).rejects.toThrow("iMessage outbound role protection failed");
      await expect(
        sendMessageIMessage(
          "chat_id:10",
          nestMarkdownFences("<thinking>HIDDEN_RPC_DEEPLY_NESTED</thinking>", 4),
          { config: cfg },
        ),
      ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: [fencedYaml, forgedTokenEntity].join("\n"),
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage outbound role protection failed");
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: "`<relevant_memories>HIDDEN_ACTION_INLINE_MEMORY</relevant_memories>`",
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: roleTokenSwap,
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage outbound role protection failed");
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: nestMarkdownFences("<relevant_memories>HIDDEN_RICH_NESTED</relevant_memories>", 4),
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: "# user:",
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage rich send requires text or an attachment after sanitization");
      await expect(
        imessageActionsRuntime.editMessage({
          chatGuid: actionOptions.chatGuid,
          messageId: "edit-message-guid",
          text: "user:",
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
      await expect(
        imessageActionsRuntime.editMessage({
          chatGuid: actionOptions.chatGuid,
          messageId: "edit-message-guid",
          text: "safe edit",
          backwardsCompatMessage: "system:",
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
      for (const [questionText, choices] of [
        ["assistant:", ["first", "second"]],
        ["safe question", ["first", "system:"]],
      ] as const) {
        await expect(
          imessageActionsRuntime.sendPoll({
            chatGuid: actionOptions.chatGuid,
            question: questionText,
            choices,
            options: actionOptions,
          }),
        ).rejects.toThrow(
          "iMessage poll requires a non-empty question and options after sanitization",
        );
      }
      await expect(
        imessageActionsRuntime.sendPoll({
          chatGuid: actionOptions.chatGuid,
          question: "Choose one",
          choices: ["Allow", `Al${rawSeparator}low`],
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage poll options must remain distinct after sanitization");

      for (const sendSwappedRole of [
        () =>
          imessageActionsRuntime.editMessage({
            chatGuid: actionOptions.chatGuid,
            messageId: "edit-message-guid",
            text: roleTokenSwap,
            backwardsCompatMessage: "visible fallback",
            options: actionOptions,
          }),
        () =>
          imessageActionsRuntime.editMessage({
            chatGuid: actionOptions.chatGuid,
            messageId: "edit-message-guid",
            text: "visible replacement",
            backwardsCompatMessage: roleTokenSwap,
            options: actionOptions,
          }),
        () =>
          imessageActionsRuntime.sendPoll({
            chatGuid: actionOptions.chatGuid,
            question: roleTokenSwap,
            choices: ["first", "second"],
            options: actionOptions,
          }),
        () =>
          imessageActionsRuntime.sendPoll({
            chatGuid: actionOptions.chatGuid,
            question: "visible question",
            choices: [roleTokenSwap, "second"],
            options: actionOptions,
          }),
        () =>
          imessageActionsRuntime.sendPoll({
            chatGuid: actionOptions.chatGuid,
            question: "visible question",
            choices: ["first", roleTokenSwap],
            options: actionOptions,
          }),
      ]) {
        await expect(sendSwappedRole()).rejects.toThrow("iMessage outbound role protection failed");
      }

      for (const tag of ["thinking", "relevant_memories"] as const) {
        for (const hidden of [
          `<${tag}>HIDDEN_RAW_CODE_PAYLOAD</${tag}>`,
          `<${tag}>HIDDEN_UNTERMINATED_RAW_CODE_PAYLOAD`,
          ...(tag === "thinking" ? [hiddenFunctionResponse] : []),
        ]) {
          for (const wrapped of [
            `\`\`\`xml\n${hidden}\n\`\`\``,
            `\`${hidden}\``,
            nestMarkdownFences(hidden, 3),
          ]) {
            const actionsWithHiddenCode = [
              () =>
                imessageActionsRuntime.editMessage({
                  chatGuid: actionOptions.chatGuid,
                  messageId: "edit-message-guid",
                  text: wrapped,
                  backwardsCompatMessage: "visible fallback",
                  options: actionOptions,
                }),
              () =>
                imessageActionsRuntime.editMessage({
                  chatGuid: actionOptions.chatGuid,
                  messageId: "edit-message-guid",
                  text: "visible replacement",
                  backwardsCompatMessage: wrapped,
                  options: actionOptions,
                }),
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: wrapped,
                  choices: ["first", "second"],
                  options: actionOptions,
                }),
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: "visible question",
                  choices: [wrapped, "second"],
                  options: actionOptions,
                }),
              () =>
                imessageActionsRuntime.sendPoll({
                  chatGuid: actionOptions.chatGuid,
                  question: "visible question",
                  choices: ["first", wrapped],
                  options: actionOptions,
                }),
            ];
            for (const sendHiddenCode of actionsWithHiddenCode) {
              await expect(sendHiddenCode()).rejects.toThrow(
                "iMessage outbound hidden assistant content is not allowed",
              );
            }
          }
        }
      }
      expect(readActions()).toHaveLength(actions.length);
      expect(readRequests()).toHaveLength(requests.length);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("attaches a text receipt for native send ids", async () => {
    const client = createClient({ guid: "p:0/imsg-1" });

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "reply-1",
    });

    expect(result.messageId).toBe("p:0/imsg-1");
    expect(result.sentText).toBe("hello");
    expect(result.echoText).toBe("hello");
    expect(result.receipt.primaryPlatformMessageId).toBe("p:0/imsg-1");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/imsg-1"]);
    expect(result.receipt.replyToId).toBe("reply-1");
    expect(result.receipt.raw).toEqual([
      {
        channel: "imessage",
        messageId: "p:0/imsg-1",
        chatId: "42",
        meta: { targetKind: "chat_id" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "p:0/imsg-1",
        kind: "text",
        replyToId: "reply-1",
        raw: {
          channel: "imessage",
          messageId: "p:0/imsg-1",
          chatId: "42",
          meta: { targetKind: "chat_id" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("rejects an unsuccessful RPC send instead of acknowledging a delivered message", async () => {
    const client = createClient({ success: false, error: "recipient is not registered" });

    await expect(
      sendMessageIMessage("+15551234567", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
      }),
    ).rejects.toThrow("recipient is not registered");

    expect(
      hasPersistedIMessageEcho({
        scope: "default:imessage:+15551234567",
        text: "hello",
        includePendingText: true,
      }),
    ).toBe(false);
  });

  it("drops reply metadata from text sends when reply actions are disabled", async () => {
    const client = createClient({ guid: "p:0/imsg-plain" });

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
            actions: { reply: false },
            accounts: { default: {} },
          },
        },
      },
      client,
      replyToId: "reply-1",
    });

    const sendParams = getClientMocks(client).request.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(sendParams).not.toHaveProperty("reply_to");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
  });

  it("rejects an unbound delegated reply before media or provider access", async () => {
    const client = createClient({ guid: "should-not-send" });
    const resolveAttachment = vi.fn(async () => ({
      path: "/tmp/image.png",
      contentType: "image/png",
    }));

    await expect(
      sendMessageIMessage("chat_id:42", "caption", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        conversationReadOrigin: "delegated",
        mediaUrl: "/tmp/image.png",
        replyToId: "unbound-reply-guid",
        resolveAttachmentImpl: resolveAttachment,
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(resolveAttachment).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("allows a delegated reply with a current same-account cache binding", async () => {
    const client = createClient({ guid: "p:0/imsg-bound" });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "bound-reply-guid",
      chatId: 42,
      timestamp: Date.now(),
    });

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        conversationReadOrigin: "delegated",
        replyToId: "bound-reply-guid",
      }),
    ).resolves.toMatchObject({ messageId: "p:0/imsg-bound" });

    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ chat_id: 42, reply_to: "bound-reply-guid" }),
      expect.any(Object),
    );
  });

  it("uses the effective SMS service for a delegated raw-handle reply", async () => {
    const client = createClient({ guid: "p:0/imsg-sms-bound" });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "sms-reply-guid",
      chatGuid: "SMS;-;+15550004567",
      chatIdentifier: "+15550004567",
      timestamp: Date.now(),
    });

    await expect(
      sendMessageIMessage("+15550004567", "hello", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        service: "sms",
        conversationReadOrigin: "delegated",
        replyToId: "sms-reply-guid",
      }),
    ).resolves.toMatchObject({ messageId: "p:0/imsg-sms-bound" });

    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        service: "sms",
        reply_to: "sms-reply-guid",
      }),
      expect.any(Object),
    );
  });

  it("rejects a delegated reply when an auto handle has no concrete service", async () => {
    const client = createClient({ guid: "should-not-send" });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "ambiguous-service-guid",
      chatGuid: "SMS;-;+15550004567",
      chatIdentifier: "+15550004567",
      timestamp: Date.now(),
    });

    await expect(
      sendMessageIMessage("+15550004567", "hello", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        conversationReadOrigin: "delegated",
        replyToId: "ambiguous-service-guid",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("caches provider-resolved chat IDs with the canonical effective service", async () => {
    const client = createClient({
      guid: "p:0/imsg-canonical",
      chat_guid: "SMS;-;+15550004567",
      service: "SMS",
    });

    const result = await sendMessageIMessage("+1 (555) 000-4567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result).toMatchObject({
      service: "sms",
      chatGuid: "SMS;-;+15550004567",
    });
    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "SMS;-;+15550004567",
        chatIdentifier: "SMS;-;+15550004567",
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: "p:0/imsg-canonical",
        chatGuid: "SMS;-;+15550004567",
        chatIdentifier: "SMS;-;+15550004567",
        isFromMe: true,
      }),
    );
  });

  it("infers the confirmed service from the provider chat GUID", async () => {
    const client = createClient({
      guid: "p:0/imsg-canonical-guid-only",
      chat_guid: "SMS;-;+15550004567",
    });

    await expect(
      sendMessageIMessage("+1 (555) 000-4567", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
      }),
    ).resolves.toMatchObject({
      service: "sms",
      chatGuid: "SMS;-;+15550004567",
    });
  });

  it("caches the provider-resolved GUID alongside an outbound chat ID", async () => {
    const client = createClient({
      guid: "p:0/imsg-chat-id",
      chat_guid: "iMessage;+;group-guid",
      service: "iMessage",
    });

    await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatId: 42,
        chatGuid: "iMessage;+;group-guid",
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: "p:0/imsg-chat-id",
        chatId: 42,
        chatGuid: "iMessage;+;group-guid",
        isFromMe: true,
      }),
    );
  });

  it("resends unthreaded when the transport cannot deliver a threaded reply (#99638)", async () => {
    const sendParams: Array<Record<string, unknown>> = [];
    const client = {
      request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
        sendParams.push(params);
        if (params.reply_to) {
          throw new Error(
            "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
          );
        }
        return { guid: "p:0/imsg-plain-fallback" };
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "reply-1",
    });

    // First attempt carried reply_to and hard-failed on the AppleScript-only
    // transport; the retry drops reply_to and delivers rather than losing it.
    expect(sendParams).toHaveLength(2);
    expect(sendParams[0]).toHaveProperty("reply_to", "reply-1");
    expect(sendParams[1]).not.toHaveProperty("reply_to");
    expect(result.messageId).toBe("p:0/imsg-plain-fallback");
    expect(result.sentText).toBe("hello");
    // The receipt reflects the unthreaded send that was actually delivered.
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
  });

  it("resends a media reply unthreaded when threaded replies are unsupported (#99638)", async () => {
    const sendParams: Array<Record<string, unknown>> = [];
    const client = {
      request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
        sendParams.push(params);
        if (params.reply_to) {
          throw new Error(
            "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
          );
        }
        return { guid: "p:0/media-plain-fallback" };
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    // A media reply (file + reply_to) takes the main send path, not send-attachment.
    const result = await sendMessageIMessage("chat_id:42", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "reply-1",
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
    });

    expect(sendParams).toHaveLength(2);
    expect(sendParams[0]).toMatchObject({ reply_to: "reply-1", file: "/tmp/image.png" });
    expect(sendParams[1]).not.toHaveProperty("reply_to");
    // The media itself is still delivered on the retry, just unthreaded.
    expect(sendParams[1]).toHaveProperty("file", "/tmp/image.png");
    expect(result.messageId).toBe("p:0/media-plain-fallback");
    expect(result.receipt.replyToId).toBeUndefined();
  });

  it("passes the default RPC send transport", async () => {
    const client = createClient({ guid: "p:0/imsg-transport-default" });

    await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        text: "hello",
        transport: "auto",
      }),
      expect.any(Object),
    );
  });

  it("passes the configured RPC send transport", async () => {
    const client = createClient({ guid: "p:0/imsg-transport-bridge" });

    await sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
            sendTransport: "applescript",
            accounts: {
              work: {
                sendTransport: "bridge",
              },
            },
          },
        },
      },
      accountId: "work",
      client,
    });

    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        text: "hello",
        transport: "bridge",
      }),
      expect.any(Object),
    );
  });

  it("floors a configured probe timeout so one delayed imsg fallback can resolve", async () => {
    vi.useFakeTimers();
    const delayedFallbackMs = 158_000;
    const client = {
      request: vi.fn(
        (_method: string, _params: Record<string, unknown>, opts?: { timeoutMs?: number }) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("imsg rpc timeout (send)")),
              opts?.timeoutMs,
            );
            setTimeout(() => {
              clearTimeout(timeout);
              resolve({ guid: "p:0/imsg-delayed-fallback" });
            }, delayedFallbackMs);
          }),
      ),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
            ...IMESSAGE_TEST_CFG.channels.imessage,
            probeTimeoutMs: 10_000,
          },
        },
      },
      client,
    });
    await vi.advanceTimersByTimeAsync(delayedFallbackMs);

    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-delayed-fallback" });
    expect(getClientMocks(client).request).toHaveBeenCalledTimes(1);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("sends explicit chat media-only payloads through send-attachment auto transport", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "p:0/media-guid", transferGuid: "transfer-1" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });
    expect(result.messageId).toBe("p:0/media-guid");
    expect(result.echoText).toBeUndefined();
    expect(result.echoMedia).toEqual({ contentType: "image/png", kind: "image" });
    expect(result.receipt.primaryPlatformMessageId).toBe("p:0/media-guid");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/media-guid"]);
    expect(client["request"]).not.toHaveBeenCalled();
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "imessage",
        messageId: "p:0/media-guid",
        conversationId: "chat-1",
        meta: { targetKind: "chat_guid" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "p:0/media-guid",
        kind: "media",
        raw: {
          channel: "imessage",
          messageId: "p:0/media-guid",
          conversationId: "chat-1",
          meta: { targetKind: "chat_guid" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it.each([
    { kind: "document", filename: "quarterly-report.pdf", audioAsVoice: false },
    { kind: "voice", filename: "spoken-reply.mp3", audioAsVoice: true },
  ] as const)(
    "preserves the original $kind filename through the real media store and native CLI provider",
    async ({ filename, audioAsVoice }) => {
      const attachmentBytes = Buffer.from(`actual-provider-attachment-${filename}`);
      const sourcePath = createOutboundMediaFile(filename, attachmentBytes);
      const deliveredPaths: string[] = [];
      const runCliJson = vi.fn(async (args: readonly string[]) => {
        const attachmentPath = args[args.indexOf("--file") + 1];
        expect(attachmentPath).toBeDefined();
        deliveredPaths.push(attachmentPath!);
        expect(fs.readFileSync(attachmentPath!)).toEqual(attachmentBytes);
        return { messageId: "p:0/provider-accepted-media" };
      });

      await sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        mediaUrl: sourcePath,
        mediaLocalRoots: [openClawState.root],
        audioAsVoice,
        runCliJson,
      });

      expect(deliveredPaths.map((attachmentPath) => path.basename(attachmentPath))).toEqual([
        filename,
      ]);
      expect(fs.existsSync(deliveredPaths[0]!)).toBe(false);
      const storedFilenames = fs.readdirSync(openClawState.statePath("media", "outbound"));
      expect(storedFilenames).toHaveLength(1);
      expect(storedFilenames[0]).toMatch(/---[a-f\d-]{36}\./iu);
      expect(
        fs.readFileSync(openClawState.statePath("media", "outbound", storedFilenames[0]!)),
      ).toEqual(attachmentBytes);
      expect(fs.existsSync(sourcePath)).toBe(true);
    },
  );

  it("cleans an original-name CLI attachment workspace when the native provider rejects it", async () => {
    const filename = "rejected-report.pdf";
    const sourcePath = createOutboundMediaFile(filename, Buffer.from("provider rejection bytes"));
    let deliveredPath: string | undefined;
    const providerError = new Error("native attachment rejected");
    const runCliJson = vi.fn(async (args: readonly string[]) => {
      deliveredPath = args[args.indexOf("--file") + 1];
      expect(path.basename(deliveredPath!)).toBe(filename);
      expect(fs.existsSync(deliveredPath!)).toBe(true);
      throw providerError;
    });

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        mediaUrl: sourcePath,
        mediaLocalRoots: [openClawState.root],
        runCliJson,
      }),
    ).rejects.toBe(providerError);

    expect(deliveredPath).toBeDefined();
    expect(fs.existsSync(deliveredPath!)).toBe(false);
    expect(fs.readdirSync(openClawState.statePath("media", "outbound"))).toHaveLength(1);
  });

  it("sends audioAsVoice media through send-attachment audio transport", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/voice-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/voice-guid");
    expect(runCliJson.mock.calls).toEqual([
      [
        [
          "send-attachment",
          "--chat",
          "chat-1",
          "--file",
          "/tmp/voice.caf",
          "--audio",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it.each([
    { name: "media", audioAsVoice: false, sendTransport: "bridge" },
    { name: "media", audioAsVoice: false, sendTransport: "applescript" },
    { name: "voice", audioAsVoice: true, sendTransport: "bridge" },
  ] as const)(
    "honors the configured $sendTransport transport for $name attachment sends",
    async ({ audioAsVoice, sendTransport }) => {
      const client = createClient({ message_id: 12345 });
      const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/configured-media-guid" });
      const mediaPath = audioAsVoice ? "/tmp/voice.caf" : "/tmp/image.png";

      await sendMessageIMessage("chat_guid:chat-1", "", {
        config: {
          channels: {
            imessage: {
              sendTransport: sendTransport === "bridge" ? "applescript" : "bridge",
              accounts: { work: { sendTransport } },
            },
          },
        },
        accountId: "work",
        client,
        mediaUrl: mediaPath,
        audioAsVoice,
        resolveAttachmentImpl: async () => ({
          path: mediaPath,
          contentType: audioAsVoice ? "audio/x-caf" : "image/png",
        }),
        runCliJson,
      });

      expect(runCliJson).toHaveBeenCalledWith([
        "send-attachment",
        "--chat",
        "chat-1",
        "--file",
        mediaPath,
        ...(audioAsVoice ? ["--audio"] : []),
        "--transport",
        sendTransport === "bridge" ? "dylib" : sendTransport,
      ]);
      expect(getClientMocks(client).request).not.toHaveBeenCalled();
    },
  );

  it("preserves audioAsVoice media when replying to an iMessage thread", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/threaded-voice-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      replyToId: "p:0/reply-guid",
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/threaded-voice-guid");
    expect(runCliJson.mock.calls).toEqual([
      [
        [
          "send-attachment",
          "--chat",
          "chat-1",
          "--file",
          "/tmp/voice.caf",
          "--audio",
          "--reply-to",
          "p:0/reply-guid",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(result.receipt.replyToId).toBe("p:0/reply-guid");
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it.each([undefined, "p:0/reply-guid"])(
    "rejects AppleScript voice notes without downgrading native audio (reply: %s)",
    async (replyToId) => {
      const client = createClient({ guid: "should-not-send" });
      const runCliJson = vi.fn();

      await expect(
        sendMessageIMessage("chat_guid:chat-1", "", {
          config: { channels: { imessage: { sendTransport: "applescript" } } },
          client,
          conversationReadOrigin: "direct-operator",
          mediaUrl: "/tmp/voice.caf",
          audioAsVoice: true,
          replyToId,
          resolveAttachmentImpl: async () => ({
            path: "/tmp/voice.caf",
            contentType: "audio/x-caf",
          }),
          runCliJson,
        }),
      ).rejects.toThrow("voice messages require bridge transport");

      expect(runCliJson).not.toHaveBeenCalled();
      expect(getClientMocks(client).request).not.toHaveBeenCalled();
    },
  );

  it("does not downgrade voice notes when the native attachment bridge is unavailable", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = vi.fn().mockRejectedValueOnce(new Error("private API bridge unavailable"));

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/voice.caf",
        audioAsVoice: true,
        resolveAttachmentImpl: async () => ({
          path: "/tmp/voice.caf",
          contentType: "audio/x-caf",
        }),
        runCliJson,
      }),
    ).rejects.toThrow("private API bridge unavailable");

    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("drops reply metadata from media sends when reply actions are disabled", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/plain-media-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: {
        channels: {
          imessage: {
            actions: { reply: false },
            accounts: { default: {} },
          },
        },
      },
      client,
      mediaUrl: "/tmp/image.png",
      replyToId: "p:0/reply-guid",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/plain-media-guid");
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("resolves chat_id media-only payloads before using send-attachment", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ guid: "any;+;group-guid" })
      .mockResolvedValueOnce({ messageId: "p:0/media-guid" });

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/media-guid");
    expect(client["request"]).not.toHaveBeenCalled();
    expect(runCliJson.mock.calls).toEqual([
      [["group", "--chat-id", "42"]],
      [
        [
          "send-attachment",
          "--chat",
          "any;+;group-guid",
          "--file",
          "/tmp/image.png",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "any;+;group-guid",
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: "p:0/media-guid",
        chatGuid: "any;+;group-guid",
        chatId: 42,
        isFromMe: true,
      }),
    );
  });

  it("falls back to the existing rpc send path when send-attachment is unavailable", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockRejectedValueOnce(new Error("unknown command send-attachment"));

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("12345");
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(client["request"]).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_guid: "chat-1",
        file: "/tmp/image.png",
        text: "",
      }),
      expect.any(Object),
    );
  });

  it("falls back to the existing rpc send path when chat_id lookup is unavailable", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockRejectedValueOnce(new Error("private API bridge unavailable"));

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("12345");
    expect(runCliJson.mock.calls).toEqual([[["group", "--chat-id", "42"]]]);
    expect(client["request"]).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        file: "/tmp/image.png",
        text: "",
      }),
      expect.any(Object),
    );
  });

  it("rejects failed send-attachment json instead of reporting success", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: "attachment delivery failed" });

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
      }),
    ).rejects.toThrow("attachment delivery failed");
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("routes DM handle media-only sends through send-attachment", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("+15550004567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/dm-media-guid");
    expect(runCliJson).toHaveBeenCalledTimes(1);
    const attachmentArgs = runCliJson.mock.calls[0]?.[0] as string[];
    expect(attachmentArgs[0]).toBe("send-attachment");
    expect(attachmentArgs[1]).toBe("--chat");
    expect(attachmentArgs[2]).toBe("any;-;+15550004567");
    expect(attachmentArgs.slice(3)).toEqual(["--file", "/tmp/image.png", "--transport", "auto"]);
    const cachedEntry = findLatestIMessageEntryForChat({
      accountId: "default",
      chatIdentifier: "any;-;+15550004567",
    });
    expect(cachedEntry).toEqual(
      expect.objectContaining({
        messageId: "p:0/dm-media-guid",
        chatIdentifier: "any;-;+15550004567",
        isFromMe: true,
      }),
    );
    expect(cachedEntry).not.toHaveProperty("chatGuid");
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves explicit SMS service for bare-handle media sends", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/sms-media-guid" });

    await sendMessageIMessage("+15550004567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      service: "sms",
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls[0]?.[0]).toEqual([
      "send-attachment",
      "--chat",
      "SMS;-;+15550004567",
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves configured iMessage service for bare-handle media sends", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/imessage-media-guid" });

    await sendMessageIMessage("+15550004567", "", {
      config: {
        channels: {
          imessage: {
            accounts: {
              default: {
                service: "imessage",
              },
            },
          },
        },
      },
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls[0]?.[0]).toEqual([
      "send-attachment",
      "--chat",
      "iMessage;-;+15550004567",
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("keeps national-format phone media sends on the region-aware RPC path", async () => {
    const client = createClient({ guid: "p:0/media-guid" });
    const runCliJson = vi.fn();

    const result = await sendMessageIMessage("555-000-4567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      region: "US",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        file: "/tmp/image.png",
        region: "US",
        to: "555-000-4567",
      }),
      expect.any(Object),
    );
    expect(result.messageId).toBe("p:0/media-guid");
  });

  it("keeps chat_identifier media sends on the rpc send path", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn();

    await sendMessageIMessage("chat_identifier:team-thread", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(client["request"]).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_identifier: "team-thread",
        file: "/tmp/image.png",
      }),
      expect.any(Object),
    );
  });

  it("preserves staged filenames across native RPC sends and their unthreaded retry", async () => {
    const filename = "threaded-review.pdf";
    const attachmentBytes = Buffer.from("actual native rpc provider bytes");
    const sourcePath = createOutboundMediaFile(filename, attachmentBytes);
    const deliveredPaths: string[] = [];
    const client = {
      request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
        const attachmentPath = params.file as string;
        deliveredPaths.push(attachmentPath);
        expect(fs.readFileSync(attachmentPath)).toEqual(attachmentBytes);
        if (params.reply_to) {
          throw new Error(
            "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
          );
        }
        return { guid: "p:0/provider-accepted-rpc" };
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const result = await sendMessageIMessage("chat_id:42", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "p:0/thread-root",
      mediaUrl: sourcePath,
      mediaLocalRoots: [openClawState.root],
    });

    expect(result.messageId).toBe("p:0/provider-accepted-rpc");
    expect(deliveredPaths.map((attachmentPath) => path.basename(attachmentPath))).toEqual([
      filename,
      filename,
    ]);
    expect(deliveredPaths.every((attachmentPath) => !fs.existsSync(attachmentPath))).toBe(true);
    expect(fs.readdirSync(openClawState.statePath("media", "outbound"))).toHaveLength(1);
  });

  it("sends DM handle media captions as attachment plus follow-up text", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("imessage:+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).toHaveBeenCalledTimes(1);
    const captionAttachmentArgs = runCliJson.mock.calls[0]?.[0] as string[];
    expect(captionAttachmentArgs[0]).toBe("send-attachment");
    expect(captionAttachmentArgs[1]).toBe("--chat");
    expect(captionAttachmentArgs[2]).toBe("iMessage;-;+15550004567");
    expect(captionAttachmentArgs.slice(3)).toEqual([
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(result.sentText).toBe("caption");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/dm-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("does not persist caption text when the caption follow-up send fails", async () => {
    const captionError = new Error("caption failed");
    const client = createRejectingClient(captionError);
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });
    const onDeliveryResult = vi.fn();

    let observedError: unknown;
    try {
      await sendMessageIMessage("imessage:+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
        onDeliveryResult,
      });
    } catch (error) {
      observedError = error;
    }

    expect(isChannelPartialDeliveryError(observedError)).toBe(true);
    expect(observedError).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: captionError,
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        content: "",
        messageIds: ["p:0/dm-media-guid"],
        receipt: {
          primaryPlatformMessageId: "p:0/dm-media-guid",
          platformMessageIds: ["p:0/dm-media-guid"],
          parts: [expect.objectContaining({ kind: "media" })],
        },
        visibleReplySent: true,
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        visibleReplySent: true,
        receipt: expect.objectContaining({
          platformMessageIds: ["p:0/dm-media-guid"],
        }),
      }),
    );
    const scope = "default:imessage:+15550004567";
    expect(hasPersistedIMessageEcho({ scope, text: "caption" })).toBe(false);
    expect(
      hasPersistedIMessageEcho({ scope, media: { contentType: "image/png", kind: "image" } }),
    ).toBe(true);
    expect(hasPersistedIMessageEcho({ scope, messageId: "p:0/dm-media-guid" })).toBe(true);
  });

  it("stops before a caption when accepted attachment custody cannot be recorded", async () => {
    const custodyError = new Error("accepted attachment custody failed");
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });
    const onDeliveryResult = vi.fn(async () => {
      throw custodyError;
    });

    await expect(
      sendMessageIMessage("imessage:+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
        onDeliveryResult,
      }),
    ).rejects.toBe(custodyError);

    expect(isChannelPartialDeliveryError(custodyError)).toBe(false);
    expect(runCliJson).toHaveBeenCalledOnce();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        receipt: expect.objectContaining({
          platformMessageIds: ["p:0/dm-media-guid"],
        }),
        visibleReplySent: true,
      }),
    );
  });

  it("returns the caption message id when captioned attachment only has a placeholder id", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ success: true });

    const result = await sendMessageIMessage("+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/caption-guid");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["text"]);
  });

  it("sends explicit chat media captions as attachment plus follow-up text", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/chat-media-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_guid: "chat-1",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(result.sentText).toBe("caption");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/chat-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("closes created caption follow-up clients when no caller client is supplied", async () => {
    const createdClient = createClient({ guid: "p:0/caption-guid" });
    const createClientImpl = vi.fn(async () => createdClient);
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      createClient: createClientImpl,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(createClientImpl).toHaveBeenCalledTimes(1);
    expect(getClientMocks(createdClient).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(getClientMocks(createdClient).stop).toHaveBeenCalledOnce();
    expect(result.receipt.platformMessageIds).toEqual(["p:0/dm-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("preserves literal media placeholder text when no attachment is sent", async () => {
    const client = createClient({ guid: "p:0/imsg-text" });

    const result = await sendMessageIMessage("chat_id:42", "literal <media:image> text", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result.sentText).toBe("literal <media:image> text");
    expect(result.echoText).toBe("literal <media:image> text");
    expect(client["request"]).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        text: "literal <media:image> text",
      }),
      expect.any(Object),
    );
  });

  it("does not treat compatibility ok responses as visible platform ids", async () => {
    const client = createClient({ ok: "true" });

    const result = await sendMessageIMessage("+15551234567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result.messageId).toBe("ok");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("persists an echo marker before awaiting the bridge send result", async () => {
    let resolveRequest!: (value: Record<string, unknown>) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendMessageIMessage("+15551234567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    await vi.waitFor(() => expect(getClientMocks(client).request).toHaveBeenCalled());
    expect(
      hasPersistedIMessageEcho({
        scope: "default:imessage:+15551234567",
        text: "hello",
        includePendingText: true,
      }),
    ).toBe(true);

    resolveRequest({ guid: "p:0/imsg-1" });
    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-1" });
  });

  it("keeps the pending echo marker alive for slow default-timeout sends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00Z"));
    let resolveRequest!: (value: Record<string, unknown>) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendMessageIMessage("+15551234567", "slow hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });
    expect(getClientMocks(client).request).toHaveBeenCalled();

    vi.advanceTimersByTime(61_000);
    expect(
      hasPersistedIMessageEcho({
        scope: "default:imessage:+15551234567",
        text: "slow hello",
        includePendingText: true,
      }),
    ).toBe(true);

    resolveRequest({ guid: "p:0/imsg-slow" });
    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-slow" });
  });

  it("resolves numeric chat.db ROWIDs to GUIDs for approval reaction binding", async () => {
    const client = createClient({ message_id: 12345 });
    const resolveMessageGuidImpl = vi.fn(async () => "p:0/resolved-guid");

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("12345");
    expect(result.guid).toBe("p:0/resolved-guid");
    expect(resolveMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      messageId: "12345",
    });
  });

  it("does not resolve chat.db GUIDs when the bridge already returned a GUID", async () => {
    const client = createClient({ guid: "p:0/native-guid" });
    const resolveMessageGuidImpl = vi.fn(async () => "p:0/resolved-guid");

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/native-guid");
    expect(result.guid).toBe("p:0/native-guid");
    expect(resolveMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("leaves reaction binding unset when numeric ROWID cannot be resolved", async () => {
    const client = createClient({ message_id: 12345 });
    const resolveMessageGuidImpl = vi.fn(async () => null);

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("12345");
    expect(result.guid).toBeUndefined();
  });

  it("recovers approval prompt GUID without resending when rpc send times out", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const createClientLocal = vi.fn(async () => client);
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/fallback-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      createClient: createClientLocal,
      runCliJson,
      service: "sms",
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/fallback-guid");
    expect(result.guid).toBe("p:0/fallback-guid");
    expect(client["stop"]).toHaveBeenCalledOnce();
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-123"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("uses the default local chat.db path for timeout GUID recovery", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/default-db-guid");
    const approvalText = createApprovalText("approval-default");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      runCliJson,
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/default-db-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-default"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("uses the default local chat.db path for Homebrew imsg paths", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/homebrew-guid");
    const approvalText = createApprovalText("approval-homebrew");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      cliPath: "/opt/homebrew/bin/imsg",
      runCliJson,
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/homebrew-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-homebrew"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not use the local default chat.db path for custom cliPath wrappers", async () => {
    vi.useFakeTimers({ now: 1_000 });
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText("approval-remote");
    const rejection = expect(
      sendMessageIMessage("chat_id:42", approvalText, {
        config: {
          channels: {
            imessage: {
              accounts: {
                default: {
                  remoteHost: "bot@gateway-host",
                },
              },
            },
          },
        },
        client,
        cliPath: "/Users/me/.openclaw/scripts/imsg",
        runCliJson,
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: undefined,
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-remote"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not use the local default chat.db path for auto-detected ssh wrappers", async () => {
    vi.useFakeTimers({ now: 1_000 });
    vi.stubEnv("HOME", "/Users/me");
    const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-wrapper-"));
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nexec ssh -T gateway-host imsg "$@"\n');
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText("approval-ssh-wrapper");
    try {
      const rejection = expect(
        sendMessageIMessage("chat_id:42", approvalText, {
          config: IMESSAGE_TEST_CFG,
          client,
          cliPath: wrapperPath,
          runCliJson,
          resolveSentMessageGuidImpl,
        }),
      ).rejects.toThrow("imsg rpc timeout (send)");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      fs.rmSync(wrapperDir, { recursive: true, force: true });
    }

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: undefined,
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-ssh-wrapper"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("throws the rpc timeout without matching generic text to older sent rows", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/older-identical-text-guid");

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("throws the rpc timeout without resending when sent-row recovery misses", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const rejection = expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        createClient: async () => client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(getClientMocks(client).stop).toHaveBeenCalledTimes(1);
    expect(runCliJson).not.toHaveBeenCalled();
  });

  it("does not stop caller-owned rpc clients after sent-row recovery misses", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const rejection = expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).stop).not.toHaveBeenCalled();
  });

  it("throws the rpc timeout without resending when sent-row checks are unavailable", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).stop).not.toHaveBeenCalled();
  });

  it("throws the rpc timeout without resending when approval GUID recovery misses", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText();
    const rejection = expect(
      sendMessageIMessage("chat_id:42", approvalText, {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalled();
  });

  it("recovers a GUID for approval prompts when rpc send returns only sent status", async () => {
    const client = createClient({ status: "sent" });
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/recovered-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalKind: "exec",
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("ok");
    expect(result.guid).toBe("p:0/recovered-guid");
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { chatId: 42 },
        messageId: "p:0/recovered-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "approval-123",
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-123"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not poll for approval prompt GUIDs when chat.db is unavailable", async () => {
    const client = createClient({ status: "sent" });
    const approvalText = createApprovalText();
    const startedAt = performance.now();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/path/to/missing/chat.db",
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(result.messageId).toBe("ok");
    expect(result.guid).toBeUndefined();
  });

  it("does not use one-shot imsg fallback for non-timeout rpc send errors", async () => {
    const client = createRejectingClient(new Error("imsg rpc error (send)"));
    const runCliJson = vi.fn();

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
      }),
    ).rejects.toThrow("imsg rpc error (send)");

    expect(runCliJson).not.toHaveBeenCalled();
  });
});

describe("sendMessageIMessage CLI wrapper errors", () => {
  beforeEach(async () => {
    await loadFreshSendModule();
  });

  afterEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("preserves canonical CLI wrapper errors during attachment send", async () => {
    const wrapperError = new Error("imsg execution failed");
    const runCliJson = vi.fn().mockRejectedValue(wrapperError);

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        mediaUrl: "/tmp/image.png",
        runCliJson,
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      }),
    ).rejects.toBe(wrapperError);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
