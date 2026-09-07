import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { createQaBusState } from "./bus-state.js";
import type { TelegramUserbotUpdate } from "./live-transports/telegram/userbot-driver.runtime.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById, type QaScenarioFlow } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import type { QaSuiteStep } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

function formatTestTranscript(state: ReturnType<typeof createQaBusState>) {
  return state
    .getSnapshot()
    .messages.map((message) => `${message.direction}:${message.conversation.id}:${message.text}`)
    .join("\n");
}

export async function runLoadedScenarioFlow(
  scenarioId: string,
  params: {
    flow?: QaScenarioFlow;
    api?: Record<string, unknown>;
    state?: ReturnType<typeof createQaBusState>;
    omitOutboundSequence?: boolean;
    onWaitForOutboundMessage?: (params: {
      waitCount: number;
      state: ReturnType<typeof createQaBusState>;
    }) => void;
  } = {},
) {
  const scenario = readQaScenarioById(scenarioId);
  const loadedFlow = scenario.execution.flow;
  if (!loadedFlow) {
    throw new Error(`scenario has no flow: ${scenarioId}`);
  }

  const state = params.state ?? createQaBusState();
  let waitCount = 0;
  const transport = {
    accountId: "qa-channel",
    state,
    reset: async () => {
      state.reset();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
      state.addInboundMessage(input),
    sendNativeCommand: async (
      input: Omit<Parameters<typeof state.addInboundMessage>[0], "nativeCommand" | "text"> & {
        command: string;
      },
    ) => {
      const { command, ...message } = input;
      state.addInboundMessage({
        ...message,
        text: `/${command}`,
        nativeCommand: { name: command },
      });
    },
    waitForNoOutbound: async () => undefined,
    waitForOutbound: async (input: {
      conversation?: { id: string; kind: string };
      sinceIndex?: number;
      textIncludes?: string;
      timeoutMs?: number;
    }) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state });
      const match = state
        .getSnapshot()
        .messages.filter((candidate) => candidate.direction === "outbound")
        .slice(input.sinceIndex ?? 0)
        .find(
          (candidate) =>
            (!input.conversation || candidate.conversation.id === input.conversation.id) &&
            (!input.conversation || candidate.conversation.kind === input.conversation.kind) &&
            (!input.textIncludes || candidate.text.includes(input.textIncludes)),
        );
      if (match) {
        state.resolvePollCursor({
          accountId: "qa-channel",
          cursor: state.getSnapshot().cursor,
          acknowledgedCursor: state.getSnapshot().cursor,
        });
        return match;
      }
      throw new Error(`timed out after ${input.timeoutMs}ms waiting for outbound marker`);
    },
    ...(params.omitOutboundSequence
      ? {}
      : {
          waitForOutboundSequence: async () => {
            throw new Error("outbound sequence not configured for this fixture");
          },
        }),
  };
  const api = {
    env: {
      providerMode: "mock-openai",
      gateway: {
        restartAfterStateMutation: async (mutate: (context: unknown) => Promise<void>) => {
          await mutate({});
        },
      },
    },
    transport,
    state,
    scenario,
    config: scenario.execution.config ?? {},
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    waitForGatewayHealthy: async () => undefined,
    waitForTransportReady: async () => undefined,
    waitForQaChannelReady: async () => undefined,
    waitForNoOutbound: async () => undefined,
    waitForCondition: async <T>(check: () => T | Promise<T | undefined>) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const value = await check();
        if (value !== undefined) {
          return value;
        }
      }
      throw new Error("test condition was not met");
    },
    sleep: async () => undefined,
    reset: async () => {
      state.reset();
    },
    resetBus: async () => {
      state.reset();
    },
    runAgentPrompt: async () => undefined,
    formatTransportTranscript: formatTestTranscript,
    waitForOutboundMessage: async (
      stateLocal: ReturnType<typeof createQaBusState>,
      predicate: (candidate: unknown) => boolean,
      timeoutMs: number,
      options?: { sinceIndex?: number },
    ) => {
      waitCount += 1;
      params.onWaitForOutboundMessage?.({ waitCount, state: stateLocal });
      const match = stateLocal
        .getSnapshot()
        .messages.slice(options?.sinceIndex ?? 0)
        .find((candidate) => predicate(candidate));
      if (match) {
        return match;
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for outbound marker`);
    },
    runScenario: async (_name: string, steps: QaSuiteStep[]) => {
      const stepResults = [];
      for (const step of steps) {
        const outcome = await step.run();
        const details = outcome?.details;
        stepResults.push({
          name: step.name,
          status: "pass" as const,
          ...(details !== undefined ? { details } : {}),
        });
      }
      return {
        name: scenario.title,
        status: "pass" as const,
        steps: stepResults,
      };
    },
    ...params.api,
  };

  return await runScenarioFlow({
    api,
    scenarioTitle: scenario.title,
    flow: params.flow ?? loadedFlow,
  });
}

export const telegramRichObservationCases = [
  "message",
  "edit",
  "stale-send",
  "stale-edit",
  "wrong-edit-marker",
  "wrong-edit-id",
  "wrong-edit-kind",
  "oversized-tree",
  "missing-content-type",
  "untyped-stale-send",
  "flattened-details",
  "flattened-list",
  "flattened-quote",
  "reactivated-literal",
  "unmatched-after-reset",
  "duplicate-run-message",
  "lost-literal-ancestor",
  "emoji-degraded",
  "first-content-failed",
  "send-error",
] as const;

export async function assertTelegramRichObservationFlow(
  testCase: (typeof telegramRichObservationCases)[number],
) {
  const fixtureRunId = "00000000-0000-4000-8000-000000000000";
  const delayedKind = testCase === "message" ? "message" : "edit";
  const rejects = !["message", "edit", "oversized-tree", "unmatched-after-reset"].includes(
    testCase,
  );
  const staleSend = testCase === "stale-send" || testCase === "untyped-stale-send";
  const untyped = testCase === "missing-content-type" || testCase === "untyped-stale-send";
  const flattenedIndex = ["flattened-details", "flattened-list", "flattened-quote"].indexOf(
    testCase,
  );
  const tempDirs = createTempDirHarness();
  const outputDir = await tempDirs.makeTempDir("telegram-rich-flow-");
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const wrap = (kind: string, text: unknown) => ({ "@type": kind, text });
  const url = (text: unknown) => ({
    ...wrap("richTextUrl", text),
    url: "https://example.com/qa",
  });
  const paragraph = (text: unknown) => ({ "@type": "pageBlockParagraph", text });
  const styled = {
    ...url(wrap("richTextBold", plain("Download"))),
    url: "https://example.com/qa?x=1",
  };
  const list = { "@type": "pageBlockList", items: [{ blocks: [paragraph(styled)] }] };
  const math = { "@type": "richTextMathematicalExpression", expression: "x" };
  const emoji = {
    "@type": "richTextCustomEmoji",
    custom_emoji_id: "4929292553544531969",
    alternative_text: "👋",
  };
  const annotation = (wrapper: (text: unknown) => unknown) =>
    paragraph({
      "@type": "richTexts",
      texts: [
        wrapper(plain("\n")),
        wrap("richTextFixed", plain("user[Thu]")),
        wrapper(plain(" trailing")),
      ],
    });
  const literalScope = (text: unknown) => ({
    "@type": "pageBlockDetails",
    header: plain("Scope"),
    blocks: [
      paragraph(plain("<custom>")),
      { "@type": "pageBlockBlockQuote", blocks: [paragraph(text)] },
      paragraph(plain("</custom>")),
    ],
  });
  const nativeBlocks = [
    { "@type": "pageBlockDetails", header: plain("More"), blocks: [paragraph(styled)] },
    list,
    { "@type": "pageBlockBlockQuote", blocks: [paragraph(styled)] },
    paragraph(url(math)),
    paragraph(wrap("richTextSpoiler", math)),
    paragraph(url(emoji)),
    paragraph(wrap("richTextSpoiler", emoji)),
    annotation(url),
    annotation((text) => wrap("richTextBold", text)),
    paragraph({
      "@type": "richTexts",
      texts: [
        url({
          "@type": "richTexts",
          texts: [
            plain("<custom><sup>"),
            wrap("richTextBold", plain("marked")),
            plain("</sup></custom>"),
          ],
        }),
        plain(" <b>"),
        wrap("richTextBold", plain("literal")),
        plain("</b> <i>alt</i> <b"),
        url(plain("r")),
        plain(">tail <!A "),
        wrap("richTextBold", plain("declared")),
        plain(">"),
      ],
    }),
    literalScope({
      "@type": "richTexts",
      texts: [plain("<sup>"), wrap("richTextBold", plain("x")), plain("</sup>")],
    }),
  ];
  type Observation = Pick<
    TelegramUserbotUpdate,
    "messageId" | "botApiMessageId" | "contentType" | "kind" | "text" | "richMessage"
  >;
  const observed: Observation[] = [];
  const observation = (
    id: number,
    block: unknown,
    kind: "message" | "edit",
    marker: string,
  ): Observation => {
    const frame: Observation = {
      messageId: (9_000 + id) * 2 ** 20,
      botApiMessageId: 9_000 + id,
      kind,
      text: `PRIVATE_UNMATCHED_BODY\n${marker}`,
      contentType: "messageRichMessage",
      richMessage: {
        "@type": "richMessage",
        blocks: [
          kind === "message" && id === flattenedIndex + 1
            ? paragraph(styled)
            : testCase === "reactivated-literal" && id === 10
              ? paragraph(wrap("richTextBold", plain("literal")))
              : testCase === "lost-literal-ancestor" && id === 11
                ? literalScope(wrap("richTextSuperscript", wrap("richTextBold", plain("x"))))
                : testCase === "emoji-degraded" && id === 6
                  ? paragraph(url(plain("👋")))
                  : testCase === "first-content-failed" && id === 1 && kind === "message"
                    ? paragraph(plain("Download"))
                    : block,
          paragraph(plain(marker)),
          ...(testCase === "oversized-tree" && id === 1 && kind === "message"
            ? [paragraph(plain("x".repeat(20_000)))]
            : []),
        ],
        sender_id: 626262626,
        chat_id: 727272727,
        message_id: 828282828,
        is_full: true,
        is_rtl: false,
      },
    };
    if (untyped) {
      delete frame.contentType;
      delete frame.richMessage;
    }
    return frame;
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const deliver = (kind: "message" | "edit", action: () => void) => {
    // Receipts settle first; native updates arrive on a later event-loop turn.
    if (kind === delayedKind) {
      timers.push(setTimeout(action, 1));
    } else {
      action();
    }
  };
  let sends = 0;
  let edits = 0;
  const markers = new Set<string>();
  const readMarker = (message: string | undefined) => {
    assert.ok(typeof message === "string");
    const marker = message.split("\n").at(-1) ?? "";
    assert.equal(markers.has(marker), false);
    markers.add(marker);
    return marker;
  };
  try {
    const pending = runLoadedScenarioFlow("telegram-rich-inline-composition", {
      api: {
        fs,
        path,
        randomUUID: () => fixtureRunId,
        env: {
          outputDir,
          providerMode: "mock-openai",
          cfg: { channels: { telegram: { accounts: { sut: { richMessages: true } } } } },
          gateway: {
            call: async (method: string, args: { message: string }) => {
              assert.equal(method, "send");
              // Telegram extracts Markdown images before dispatching to its renderer.
              const [planned] = createOutboundPayloadPlan([{ text: args.message }], {
                extractMarkdownImages: true,
              });
              assert.ok(planned);
              assert.deepEqual(planned.parts.mediaUrls, [], "rich fixtures must not fetch media");
              assert.equal(planned.parts.text, args.message);
              const block = nativeBlocks[sends];
              const id = ++sends;
              if (testCase === "send-error") {
                throw new Error("synthetic transport failure");
              }
              const marker = readMarker(args.message);
              deliver("message", () => {
                observed.push(
                  observation(
                    id,
                    block,
                    "message",
                    staleSend ? marker.replace(fixtureRunId, "prior-run") : marker,
                  ),
                );
                if (
                  id === 1 &&
                  (testCase === "unmatched-after-reset" || testCase === "duplicate-run-message")
                ) {
                  observed.push(
                    observation(
                      80,
                      block,
                      "message",
                      testCase === "unmatched-after-reset" ? "PRIOR-RUN-MARKER" : marker,
                    ),
                  );
                }
              });
              return { messageId: id };
            },
          },
        },
        transport: {
          id: "telegram",
          accountId: "sut",
          reset() {},
          buildAgentDelivery: () => ({ to: "123" }),
        },
        readTelegramMessages: () => structuredClone(observed),
        waitForCondition: waitForQaTransportCondition,
        runQaCli: async (_env: unknown, args: string[]) => {
          assert.deepEqual(args.slice(0, 2), ["message", "edit"]);
          const id = Number(args[args.indexOf("--message-id") + 1]);
          assert.equal(id, 1);
          edits += 1;
          const firstMarker = [...markers][0];
          assert.ok(firstMarker !== undefined);
          const marker = readMarker(args[args.indexOf("--message") + 1]);
          deliver("edit", () => {
            observed[0] = observation(
              testCase === "wrong-edit-id" ? id + 40 : id,
              list,
              testCase === "wrong-edit-kind" ? "message" : "edit",
              testCase === "wrong-edit-marker"
                ? marker + "-wrong"
                : testCase === "stale-edit"
                  ? firstMarker
                  : marker,
            );
          });
        },
        runAgentPrompt: () => {
          throw new Error("direct delivery must not invoke a model");
        },
      },
    });
    if (rejects) {
      await assert.rejects(
        pending,
        testCase === "send-error"
          ? /synthetic transport failure/
          : testCase === "missing-content-type" ||
              testCase === "reactivated-literal" ||
              testCase === "lost-literal-ancestor" ||
              testCase === "emoji-degraded" ||
              testCase === "first-content-failed" ||
              flattenedIndex >= 0
            ? /Native rich composition failed/
            : testCase === "duplicate-run-message"
              ? /editing must preserve the styled link/
              : /timed out after 30000ms/,
      );
    } else {
      const result = await pending;
      assert.equal(result.status, "pass");
      assert.equal(sends, 11);
      assert.equal(edits, 1);
      assert.equal(observed.length, testCase === "unmatched-after-reset" ? 12 : 11);
      assert.equal(observed[0]?.kind, "edit");
    }
    const exported = await fs.readFile(
      path.join(outputDir, "telegram-rich-inline-composition.json"),
      "utf8",
    );
    const evidence = JSON.parse(exported);
    if (testCase === "emoji-degraded" || testCase === "first-content-failed") {
      assert.equal(sends, 11, "content failure must not skip independent sends");
      assert.equal(edits, 1, "content failure must not skip the original-message edit");
      assert.equal(evidence.edit.verified, true);
      assert.equal(evidence.cases.length, 10);
      const failedLabel = testCase === "emoji-degraded" ? "message-6" : "message-1";
      assert.deepEqual(
        evidence.failures.map((failure: { label: string }) => failure.label),
        [failedLabel],
      );
      assert.equal(
        evidence.cases.some((proof: { label: string }) => proof.label === failedLabel),
        false,
      );
      assert.equal(evidence.cases.at(-1).label, "message-11");
      assert.deepEqual(
        {
          contentType: evidence.failures[0].contentType,
          full: evidence.failures[0].full,
          matchesPattern: evidence.failures[0].matchesPattern,
          block: evidence.failures[0].richMessage.blocks[0],
        },
        {
          contentType: "messageRichMessage",
          full: true,
          matchesPattern: false,
          block:
            testCase === "emoji-degraded"
              ? paragraph(url(plain("👋")))
              : paragraph(plain("Download")),
        },
      );
      assert.equal(
        evidence.candidates.find((candidate: { phase: string }) => candidate.phase === "edit")
          .observerIdStayedEqual,
        true,
      );
    }
    const contentFailure =
      flattenedIndex >= 0 ||
      [
        "reactivated-literal",
        "lost-literal-ancestor",
        "emoji-degraded",
        "first-content-failed",
      ].includes(testCase);
    assert.equal(evidence.edit.verified, !rejects || contentFailure);
    if (testCase === "send-error") {
      assert.equal(sends, 1);
      assert.equal(edits, 0);
      assert.equal(evidence.cases.length, 0);
    }
    assert.ok(exported.length < 400_000);
    for (const privateValue of [
      "626262626",
      "727272727",
      "828282828",
      "PRIVATE_UNMATCHED_BODY",
      ...observed.map((message) => String(message.messageId)),
    ]) {
      assert.equal(exported.includes(privateValue), false);
    }
    assert.equal(
      /"(?:botMessageId|observerMessageId|botApiMessageId|messageId|sender_id|chat_id|message_id)"/.test(
        exported,
      ),
      false,
    );
    if (staleSend || testCase === "wrong-edit-marker" || testCase === "unmatched-after-reset") {
      assert.equal(evidence.unmatched.count, 1);
    }
    if (testCase === "wrong-edit-id") {
      assert.equal(
        evidence.candidates.find((candidate: { phase: string }) => candidate.phase === "edit")
          .observerIdStayedEqual,
        false,
      );
    }
    if (!rejects) {
      assert.equal(evidence.cases.length, 11);
      assert.ok(
        evidence.cases.every(
          (proof: { accountMessageIdsDiffer: boolean }) => proof.accountMessageIdsDiffer,
        ),
      );
      assert.equal(evidence.edit.completedWithBotReceipt, true);
      assert.equal(
        evidence.candidates.find((candidate: { phase: string }) => candidate.phase === "edit")
          .observerIdStayedEqual,
        true,
      );
    }
    if (untyped) {
      assert.deepEqual(
        staleSend ? evidence.unmatched.contentTypes : [evidence.candidates[0].contentType],
        ["unknown"],
      );
      assert.equal(evidence.cases.length, 0);
    }
    if (testCase === "oversized-tree") {
      assert.equal(evidence.cases[0].richMessage.truncated, true);
    }
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    await tempDirs.cleanup();
  }
}
