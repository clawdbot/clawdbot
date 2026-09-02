import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  adaptMessagePresentationForChannel,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams, createDeps } from "./auto-reply-delivery.test-helpers.js";
import { processLineMessage } from "./markdown-to-line.js";
import { lineOutboundAdapter } from "./outbound.js";
import { LINE_PRESENTATION_CAPABILITIES, prepareLineReplyPayload } from "./rich-messages.js";
import { setLineRuntime } from "./runtime.js";
import { createFlexMessage, pushMessagesLine, replyMessageLine } from "./send.js";
import type { LineChannelData } from "./types.js";

type WireMessage = {
  type: string;
  text?: string;
  altText?: string;
  quickReply?: { items: Array<{ action: { label: string; text?: string; data?: string } }> };
};

type RecordedLineApiRequest = {
  method: string;
  path: string;
  authorization: string;
  body: {
    to?: string;
    replyToken?: string;
    messages: WireMessage[];
  };
};

const LINE_TEST_CFG = {
  channels: {
    line: {
      accounts: {
        default: {},
      },
    },
  },
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listenLoopback(
  requestHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void requestHandler(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LINE loopback server did not bind a TCP address");
  }
  return {
    server,
    port: address.port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

const {
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
  resolvePinnedHostnameWithPolicyMock,
} = vi.hoisted(() => ({
  requireRuntimeConfigMock: vi.fn((cfg: unknown) => cfg ?? LINE_TEST_CFG),
  resolveLineAccountMock: vi.fn(() => ({ accountId: "default" })),
  resolveLineChannelAccessTokenMock: vi.fn(() => "line-loopback-proof-token"),
  recordChannelActivityMock: vi.fn(),
  logVerboseMock: vi.fn(),
  resolvePinnedHostnameWithPolicyMock: vi.fn(async () => ({
    hostname: "api.line.me",
    addresses: ["127.0.0.1"],
  })),
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, logVerbose: logVerboseMock };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

function createLoopbackRuntime(): PluginRuntime {
  return {
    channel: {
      line: {
        resolveLineAccount: resolveLineAccountMock,
      },
      text: {
        chunkMarkdownText,
      },
    },
  } as unknown as PluginRuntime;
}

function collectAllWireMessages(requests: RecordedLineApiRequest[]): WireMessage[] {
  return requests.flatMap((r) => r.body.messages);
}

describe("Row-overflow table delivery through production outbound adapter over loopback LINE HTTP transport", () => {
  let loopback: Awaited<ReturnType<typeof listenLoopback>>;
  let requests: RecordedLineApiRequest[];
  let originalFetch: typeof globalThis.fetch;
  let loopbackFetch: typeof globalThis.fetch & { mock?: object };

  beforeEach(async () => {
    requests = [];
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-loopback-proof-token");
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "api.line.me",
      addresses: ["127.0.0.1"],
    });
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();

    loopback = await listenLoopback(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const rawBody = await readRequestBody(request);
      const body = rawBody
        ? (JSON.parse(rawBody) as RecordedLineApiRequest["body"])
        : { messages: [] };

      const record: RecordedLineApiRequest = {
        method: request.method ?? "POST",
        path: url.pathname,
        authorization: (request.headers.authorization as string) ?? "",
        body,
      };
      requests.push(record);

      if (
        url.pathname === "/v2/bot/message/push" &&
        body.to === "UtestAutoReplyRecovery" &&
        body.messages.some((message) => message.type === "flex")
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "invalid rich message" }));
        return;
      }

      if (url.pathname === "/v2/bot/message/push" || url.pathname === "/v2/bot/message/reply") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sentMessages: body.messages.map((_, i) => ({ id: `loopback-${i}` })),
          }),
        );
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
    });

    originalFetch = globalThis.fetch;
    const loopbackOrigin = `http://127.0.0.1:${loopback.port}`;
    const realFetch = originalFetch;

    loopbackFetch = async function fetchLoopback(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);

      if (url.hostname === "api.line.me") {
        const redirectedUrl = new URL(`${url.pathname}${url.search}`, loopbackOrigin);
        return realFetch(redirectedUrl.toString(), init);
      }

      return realFetch(input, init);
    } as typeof globalThis.fetch & { mock?: object };

    loopbackFetch.mock = {};

    vi.stubGlobal("fetch", loopbackFetch);
    setLineRuntime(createLoopbackRuntime());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await loopback.close();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  it.each([
    { delivery: "reply", card: false },
    { delivery: "reply", card: true },
    { delivery: "push", card: false },
    { delivery: "push", card: true },
  ])("carries every select through $delivery requests (card=$card)", async ({ delivery, card }) => {
    const selects = ["environment", "region", "version"].map((kind) => ({
      type: "select" as const,
      placeholder: `Which ${kind} should receive this deployment?`,
      options: Array.from({ length: 8 }, (_, index) => ({
        label: `${kind}-${index + 1} full deployment name`,
        action: { type: "command" as const, command: `/${kind} ${index + 1}` },
      })),
    }));
    const presentation: MessagePresentation = {
      title: "Deployment choices",
      blocks: [
        { type: "context", text: "Review all three choices." },
        ...(card
          ? [
              {
                type: "buttons" as const,
                buttons: [
                  { label: "Help", action: { type: "command" as const, command: "/help" } },
                ],
              },
            ]
          : []),
        ...selects,
      ],
    };
    const payload = { text: "Deployment details. ".repeat(1_500), presentation };
    const prepared =
      delivery === "reply"
        ? prepareLineReplyPayload(payload)
        : await lineOutboundAdapter.renderPresentation!({
            payload,
            presentation: adaptMessagePresentationForChannel({
              presentation,
              capabilities: LINE_PRESENTATION_CAPABILITIES,
            }),
            ctx: {} as never,
          });
    if (!prepared) {
      throw new Error("LINE presentation did not render");
    }
    if (delivery === "reply") {
      const { deps } = createDeps({
        processLineMessage,
        chunkMarkdownText,
        createFlexMessage,
        pushMessagesLine,
        replyMessageLine,
      });
      await deliverLineAutoReply({
        ...baseDeliveryParams,
        cfg: LINE_TEST_CFG,
        accountId: "default",
        payload: prepared,
        lineData: prepared.channelData?.line as LineChannelData,
        deps,
      });
    } else {
      await lineOutboundAdapter.sendPayload!({
        to: "line:user:Uselect",
        text: prepared.text ?? "",
        payload: prepared,
        cfg: LINE_TEST_CFG,
      });
    }

    const messages = collectAllWireMessages(requests);
    const text = messages
      .filter((message) => message.type === "text")
      .map((message) => message.text)
      .join("\n");
    const options = selects.flatMap((select) => select.options);
    const controls = messages.flatMap((message) => message.quickReply?.items ?? []);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.body.messages.length <= 5)).toBe(true);
    expect(requests[0]?.path).toBe(`/v2/bot/message/${delivery}`);
    expect(controls).toHaveLength(13);
    expect(controls.map(({ action }) => action.text)).toEqual(
      options.slice(0, 13).map((option) => option.action.command),
    );
    expect(controls.every(({ action }) => Array.from(action.label).length <= 20)).toBe(true);
    expect(messages.filter((message) => message.quickReply)).toEqual([messages.at(-1)]);
    for (const select of selects) {
      expect(text).toContain(select.placeholder);
    }
    for (const option of options.slice(13)) {
      expect(text).toContain(`${option.label}: ${option.action.command}`);
    }
    expect(messages.filter((message) => message.type === "flex")).toHaveLength(card ? 1 : 0);
    expect(text.includes(presentation.title!)).toBe(!card);
  });

  it("delivers all 15 rows of a 2-column overflow table through the production outbound adapter", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| Item${i + 1} | $${i + 1}.00 |`).join("\n");
    const markdown = `Header\n\n| Name | Price |\n|---|---|\n${rows}\n\nFooter`;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Utest15",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    const allMessages = collectAllWireMessages(requests);

    expect(requests.length).toBeGreaterThanOrEqual(1);
    const pushRequest = requests.find((r) => r.path === "/v2/bot/message/push");
    expect(pushRequest).toBeDefined();
    expect(pushRequest!.authorization).toBe("Bearer line-loopback-proof-token");

    const allText = allMessages
      .filter((m) => m.type === "text" && m.text)
      .map((m) => m.text!)
      .join(" ");

    for (let i = 1; i <= 15; i++) {
      expect(allText).toContain(`Item${i}`);
    }
    expect(allText).toContain("Header");
    expect(allText).toContain("Footer");
    expect(allText.indexOf("Header")).toBeLessThan(allText.indexOf("Item1"));
    expect(allText.indexOf("Item15")).toBeLessThan(allText.indexOf("Footer"));

    expect(allMessages.some((m) => m.type === "flex" && m.altText === "Table")).toBe(false);
  });

  it("delivers all 11 rows of a 3-column overflow table through the production outbound adapter", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => `| Row${i + 1} | Val${i + 1} | Extra |`).join(
      "\n",
    );
    const markdown = `| Name | Value | Extra |\n|---|---|---|\n${rows}`;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Utest11",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    const allMessages = collectAllWireMessages(requests);
    const allText = allMessages
      .filter((m) => m.type === "text" && m.text)
      .map((m) => m.text!)
      .join(" ");

    for (let i = 1; i <= 11; i++) {
      expect(allText).toContain(`Row${i}`);
    }
  });

  it("preserves source order of kept Flex card alongside overflow text through the production outbound adapter", async () => {
    const keptTable = "| Small | Card |\n|---|---|\n| Kept | row |";
    const bigRows = Array.from({ length: 13 }, (_, i) => `| Big${i + 1} | $${i + 1}.00 |`).join(
      "\n",
    );
    const overflowTable = `| Name | Price |\n|---|---|\n${bigRows}`;
    const markdown = `Header\n\n${keptTable}\n\nBetween\n\n${overflowTable}\n\nFooter`;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:UtestMixed",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    const allMessages = collectAllWireMessages(requests);
    const flexIndices = allMessages
      .map((m, i) => (m.type === "flex" ? i : -1))
      .filter((i) => i >= 0);
    expect(flexIndices.length).toBeGreaterThanOrEqual(1);

    const firstFlexIdx = flexIndices[0]!;
    const beforeFlex = allMessages.slice(0, firstFlexIdx);
    const afterFlex = allMessages.slice(firstFlexIdx + 1);

    const beforeText = beforeFlex
      .filter((m) => m.type === "text")
      .map((m) => m.text)
      .join(" ");
    const afterText = afterFlex
      .filter((m) => m.type === "text")
      .map((m) => m.text)
      .join(" ");

    expect(beforeText).toContain("Header");
    expect(afterText).toContain("Big1");
    expect(afterText).toContain("Big13");
    expect(afterText).toContain("Footer");

    expect(beforeText).not.toContain("Big1");
    expect(afterText).not.toContain("Header");

    const allText = allMessages
      .filter((m) => m.type === "text" && m.text)
      .map((m) => m.text!)
      .join(" ");
    for (let i = 1; i <= 13; i++) {
      expect(allText).toContain(`Big${i}`);
    }
  });

  it("preserves ordinary prose, code, and table order on the actual LINE HTTP wire", async () => {
    const markdown =
      "Before\n\n```js\nfirst()\n```\n\nBetween\n\n| Name | Value |\n|---|---|\n| Item | one |\n\nAfter";

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:UtestOrdered",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    expect(
      collectAllWireMessages(requests).map((message) =>
        message.type === "flex" ? message.altText : message.text,
      ),
    ).toEqual(["Before", "Code", "Between", "Table", "After"]);
    expect(requests.every((request) => request.body.messages.length <= 5)).toBe(true);
  });

  it("delivers every line of an oversized code block through the production outbound adapter", async () => {
    const code = Array.from(
      { length: 120 },
      (_, i) => `const line${i} = ${i}; // padding pad`,
    ).join("\n");
    const markdown = `Header\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFooter`;
    expect(code.length).toBeGreaterThan(2000);

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:UtestCodeOverflow",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    const allMessages = collectAllWireMessages(requests);
    const allText = allMessages
      .filter((message) => message.type === "text" && message.text)
      .map((message) => message.text!)
      .join(" ");

    for (const line of [0, 60, 119]) {
      expect(allText).toContain(`const line${line} = ${line};`);
    }
    expect(allText).not.toContain("\n...");
    expect(allText).toContain("Header");
    expect(allText).toContain("Footer");
    expect(allText.indexOf("Header")).toBeLessThan(allText.indexOf("const line0"));
    expect(allText.indexOf("const line119")).toBeLessThan(allText.indexOf("Footer"));
    expect(allMessages.some((message) => message.altText === "Code")).toBe(false);
  });

  it("keeps rendered-code quick replies on final media on the actual LINE HTTP wire", async () => {
    const markdown = "```js\nfirst()\n```";

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:UtestRichMedia",
      text: markdown,
      payload: {
        text: markdown,
        mediaUrl: "https://example.com/image.jpg",
        channelData: { line: { quickReplies: ["Continue"] } },
      },
      cfg: LINE_TEST_CFG,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.messages).toMatchObject([
      { type: "flex", altText: "Code" },
      {
        type: "image",
        originalContentUrl: "https://example.com/image.jpg",
        quickReply: { items: [{ action: { label: "Continue", text: "Continue" } }] },
      },
    ]);
  });

  it("preserves quick replies when LINE rejects the final Markdown card", async () => {
    const { deps } = createDeps({
      processLineMessage,
      chunkMarkdownText,
      pushMessagesLine,
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      cfg: LINE_TEST_CFG,
      accountId: "default",
      to: "line:user:UtestAutoReplyRecovery",
      replyToken: undefined,
      payload: { text: "Choose one\n\n```js\nfirst()\n```" },
      lineData: { quickReplies: ["Continue"] },
      deps,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      path: "/v2/bot/message/push",
      body: {
        to: "UtestAutoReplyRecovery",
        messages: [
          { type: "text", text: "Choose one" },
          {
            type: "flex",
            altText: "Code",
            quickReply: { items: [{ action: { label: "Continue", text: "Continue" } }] },
          },
        ],
      },
    });
    expect(requests[1]).toMatchObject({
      path: "/v2/bot/message/push",
      body: {
        to: "UtestAutoReplyRecovery",
        messages: [
          {
            type: "text",
            text: "Choose one",
            quickReply: { items: [{ action: { label: "Continue", text: "Continue" } }] },
          },
        ],
      },
    });
    expect(recordChannelActivityMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
  });

  it("carries a valid Bearer token and recipient through the production outbound adapter", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| Item${i + 1} | $${i + 1}.00 |`).join("\n");
    const markdown = `| Name | Price |\n|---|---|\n${rows}`;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:UtestBearer",
      text: markdown,
      payload: { text: markdown },
      cfg: LINE_TEST_CFG,
    });

    const pushRequest = requests.find((r) => r.path === "/v2/bot/message/push");
    expect(pushRequest).toBeDefined();
    expect(pushRequest!.authorization).toMatch(/^Bearer /);
    expect(pushRequest!.body.messages.length).toBeGreaterThan(0);
  });
});
