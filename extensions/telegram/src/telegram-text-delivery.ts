import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  escapeTelegramHtml,
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
  wrapFileReferencesInHtml,
} from "./format.js";
import type { TelegramRichBlocksDegradationReason } from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import {
  buildTelegramRichBlocksPlan,
  buildTelegramRichMarkdownPlan,
  splitTelegramRichMessageTextChunks,
  type TelegramInputRichMessage,
} from "./rich-message.js";
import {
  splitTelegramPlainTextChunks,
  withTelegramPlainFallback,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";

export type TelegramTextDeliveryPage = {
  plainText: string;
  sourceText: string;
  sourceTextMode: "html" | "markdown";
  fullSourceText?: string;
  htmlText?: string;
  richMessage?: TelegramInputRichMessage;
  degradationReasons?: readonly TelegramRichBlocksDegradationReason[];
};

type TelegramTextPlanParams = {
  text: string;
  maxChars: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  textMode?: "html" | "plain";
  richMessages?: boolean;
  richMessage?: TelegramInputRichMessage;
  degradationReasons?: readonly TelegramRichBlocksDegradationReason[];
  skipEntityDetection?: boolean;
  warn?: (message: string) => void;
};

function plainPage(text: string): TelegramTextDeliveryPage {
  return {
    plainText: text,
    sourceText: text,
    sourceTextMode: "markdown",
  };
}

function fallbackPage(text: string): TelegramTextDeliveryPage {
  return {
    plainText: text,
    sourceText: escapeTelegramHtml(text),
    sourceTextMode: "html",
  };
}

export function planTelegramTextDeliveryPages(
  params: TelegramTextPlanParams,
): TelegramTextDeliveryPage[] {
  const maxChars = Math.max(1, Math.floor(params.maxChars));
  if (params.richMessages && params.textMode !== "html" && params.textMode !== "plain") {
    if (params.richMessage) {
      const skipEntityDetection = params.richMessage.skip_entity_detection === true;
      const pages = splitTelegramRichBlocks(params.richMessage.blocks, { textLimit: maxChars }).map(
        (blocks, index) => {
          const plan = buildTelegramRichBlocksPlan(blocks, { skipEntityDetection });
          const degradationReasons = index === 0 ? params.degradationReasons : undefined;
          return {
            plainText: plan.plainText,
            sourceText: plan.plainText,
            sourceTextMode: "markdown" as const,
            richMessage: plan.richMessage,
            degradationReasons,
          };
        },
      );
      if (pages.length === 0 && params.text.trim()) {
        return [
          {
            plainText: params.text,
            sourceText: params.text,
            sourceTextMode: "markdown",
            richMessage: {
              blocks: [{ type: "paragraph", text: params.text }],
              ...(skipEntityDetection ? { skip_entity_detection: true } : {}),
            },
            ...(params.degradationReasons?.length
              ? { degradationReasons: params.degradationReasons }
              : {}),
          },
        ];
      }
      return pages;
    }
    const richPlan = buildTelegramRichMarkdownPlan(params.text, {
      tableMode: params.tableMode,
      skipEntityDetection: params.skipEntityDetection,
    });
    if (richPlan.richMessage.blocks.length === 0 && params.text.trim()) {
      return [plainPage(params.text)];
    }
    return splitTelegramRichMessageTextChunks({ plan: richPlan, textLimit: maxChars }).map(
      (chunk) => ({
        plainText: chunk.plainText,
        sourceText: chunk.plainText,
        sourceTextMode: "markdown" as const,
        richMessage: chunk.richMessage,
        degradationReasons: chunk.degradationReasons,
      }),
    );
  }
  if (params.textMode === "plain") {
    return splitTelegramPlainTextChunks(params.text, maxChars)
      .map((text, index) => (index === 0 ? text.trimEnd() : text.trim()))
      .filter(Boolean)
      .map(plainPage);
  }
  if (params.textMode === "html") {
    const plainText = telegramHtmlToPlainTextFallback(params.text);
    try {
      const normalizedHtml = params.text.replace(/<br\s*\/?>/giu, "\n");
      const chunks = splitTelegramHtmlChunks(normalizedHtml, maxChars);
      return chunks.map((htmlText) => ({
        htmlText,
        plainText: chunks.length === 1 ? plainText : telegramHtmlToPlainTextFallback(htmlText),
        sourceText: htmlText,
        sourceTextMode: "html",
        fullSourceText: normalizedHtml,
      }));
    } catch (error) {
      params.warn?.(`telegram HTML chunk planning failed; sending plain text: ${String(error)}`);
      return splitTelegramPlainTextChunks(plainText, maxChars).map(plainPage);
    }
  }
  const markdownParts =
    params.chunkMode === "newline"
      ? chunkMarkdownTextWithMode(params.text, maxChars, params.chunkMode)
      : [params.text];
  const pages: TelegramTextDeliveryPage[] = [];
  for (const markdown of markdownParts) {
    const chunks = markdownToTelegramChunks(markdown, maxChars, { tableMode: params.tableMode });
    if (!chunks.length && markdown) {
      const htmlText = wrapFileReferencesInHtml(
        markdownToTelegramHtml(markdown, {
          tableMode: params.tableMode,
          wrapFileRefs: false,
        }),
      );
      pages.push({
        htmlText,
        plainText: markdown,
        sourceText: htmlText,
        sourceTextMode: "html",
      });
      continue;
    }
    pages.push(
      ...chunks.map((chunk) => ({
        htmlText: chunk.html,
        plainText: telegramHtmlToPlainTextFallback(chunk.html),
        sourceText: chunk.html,
        sourceTextMode: "html" as const,
      })),
    );
  }
  return pages;
}

type TelegramTextPageSender<TPlain, THtml, TRich> = {
  page: TelegramTextDeliveryPage;
  context: string;
  warn: (message: string) => void;
  sender: {
    sendPlain: (
      text: string,
      fallback?: { index: number; count: number },
      label?: string,
    ) => Promise<TPlain>;
    sendHtml: (html: string) => Promise<THtml>;
    sendRich: (richMessage: TelegramInputRichMessage) => Promise<TRich>;
  };
  fallbackLimit?: number;
};

// Yield outside the transport fallback catch. Observing an accepted message may
// fail, but must never turn that visible message into another send attempt.
export async function* sendTelegramTextPageParts<TPlain, THtml, TRich>(
  params: TelegramTextPageSender<TPlain, THtml, TRich>,
): AsyncGenerator<{ result: TPlain | THtml | TRich; page: TelegramTextDeliveryPage }> {
  const { page } = params;
  if (!page.richMessage && !page.htmlText) {
    yield { result: await params.sender.sendPlain(page.plainText), page };
    return;
  }
  if (page.richMessage) {
    warnTelegramRichBlocksDegradations({
      context: params.context,
      reasons: page.degradationReasons ?? [],
      warn: params.warn,
    });
  }
  const delivery = await withTelegramPlainFallback<
    { result: THtml | TRich } | { chunks: string[]; label: string }
  >({
    kind: page.richMessage ? "rich" : "html",
    context: params.context,
    plainText: page.plainText,
    warn: params.warn,
    ...(page.richMessage ? { limit: params.fallbackLimit } : {}),
    sendFormatted: async () => ({
      result: page.richMessage
        ? await params.sender.sendRich(page.richMessage)
        : await params.sender.sendHtml(page.htmlText!),
    }),
    sendPlain: async (plan, label) => ({
      chunks: page.richMessage ? plan.chunks : [plan.plainText],
      label,
    }),
  });
  if ("result" in delivery) {
    yield { result: delivery.result, page };
    return;
  }
  for (const [index, text] of delivery.chunks.entries()) {
    yield {
      result: await params.sender.sendPlain(
        text,
        page.richMessage ? { index, count: delivery.chunks.length } : undefined,
        delivery.label,
      ),
      page: fallbackPage(text),
    };
  }
}

export async function deliverTelegramTextPage<TPlain, THtml, TRich>(
  params: TelegramTextPageSender<TPlain, THtml, TRich>,
): Promise<Array<{ result: TPlain | THtml | TRich; page: TelegramTextDeliveryPage }>> {
  const delivered: Array<{ result: TPlain | THtml | TRich; page: TelegramTextDeliveryPage }> = [];
  for await (const part of sendTelegramTextPageParts(params)) {
    delivered.push(part);
  }
  return delivered;
}
