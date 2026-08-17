// OpenAI HTTP media preprocessing abort tests cover disconnects before agent dispatch.
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const extractImageContentFromSourceMock = vi.fn();
const extractPdfDocumentMock = vi.fn();

vi.mock("../media/input-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/input-files.js")>("../media/input-files.js");
  return {
    ...actual,
    extractImageContentFromSource: (...args: unknown[]) =>
      extractImageContentFromSourceMock(...args),
  };
});

vi.mock("../plugins/document-extractors.runtime.js", () => ({
  resolvePluginDocumentExtractors: () => [
    {
      id: "pdf",
      pluginId: "document-extract",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      extract: extractPdfDocumentMock,
    },
  ],
}));

import { resetConfigRuntimeState } from "../config/config.js";
import {
  createDocumentExtractorCapacityError,
  DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE,
} from "../plugins/document-extractor-types.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];
let port: number;

beforeAll(async () => {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
              images: { allowUrl: true, urlAllowlist: ["images.example.com"] },
            },
            responses: { enabled: true },
          },
        },
      },
    }),
    "utf-8",
  );
  resetConfigRuntimeState();

  const started = await startGatewayServerWithRetries({
    port: await getFreePort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
      openResponsesEnabled: true,
    },
  });
  port = started.port;
  server = started.server;
});

afterAll(async () => {
  await server?.close({ reason: "openai media preprocessing abort suite done" });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenAI HTTP media preprocessing", () => {
  it("aborts blocked image preprocessing when the client disconnects", async () => {
    let preprocessingSignal: AbortSignal | undefined;
    extractImageContentFromSourceMock.mockImplementationOnce(
      (_source: unknown, _limits: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          preprocessingSignal = signal;
          const rejectForAbort = () =>
            reject(signal?.reason instanceof Error ? signal.reason : new Error("request aborted"));
          if (signal?.aborted) {
            rejectForAbort();
            return;
          }
          signal?.addEventListener("abort", rejectForAbort, { once: true });
        }),
    );

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
      },
    });
    clientReq.on("error", () => {});
    clientReq.end(
      JSON.stringify({
        model: "openclaw",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              {
                type: "image_url",
                image_url: { url: "https://images.example.com/blocked.png" },
              },
            ],
          },
        ],
      }),
    );

    try {
      await vi.waitFor(() => expect(extractImageContentFromSourceMock).toHaveBeenCalledTimes(1));
      clientReq.destroy();

      await vi.waitFor(() => expect(preprocessingSignal?.aborted).toBe(true), {
        timeout: 1_000,
        interval: 20,
      });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      clientReq.destroy();
    }
  });

  it("returns a retryable service-unavailable response when PDF extraction is saturated", async () => {
    extractPdfDocumentMock.mockRejectedValueOnce(
      createDocumentExtractorCapacityError("PDF extraction worker queue is full"),
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
      },
      body: JSON.stringify({
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: Buffer.from("%PDF-1.4 saturated").toString("base64"),
                  filename: "scan.pdf",
                },
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Document extraction is temporarily busy; retry shortly.",
        type: "service_unavailable",
        code: DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE,
      },
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("aborts blocked OpenResponses PDF parsing when the client disconnects", async () => {
    let preprocessingSignal: AbortSignal | undefined;
    extractPdfDocumentMock.mockImplementationOnce(
      (request: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          preprocessingSignal = request.signal;
          const rejectForAbort = () =>
            reject(
              request.signal?.reason instanceof Error
                ? request.signal.reason
                : new Error("request aborted"),
            );
          if (request.signal?.aborted) {
            rejectForAbort();
            return;
          }
          request.signal?.addEventListener("abort", rejectForAbort, { once: true });
        }),
    );

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.write",
      },
    });
    clientReq.on("error", () => {});
    clientReq.end(
      JSON.stringify({
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: Buffer.from("%PDF-1.4 blocked").toString("base64"),
                  filename: "scan.pdf",
                },
              },
            ],
          },
        ],
      }),
    );

    try {
      await vi.waitFor(() => expect(extractPdfDocumentMock).toHaveBeenCalledTimes(1));
      clientReq.destroy();

      await vi.waitFor(() => expect(preprocessingSignal?.aborted).toBe(true), {
        timeout: 1_000,
        interval: 20,
      });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      clientReq.destroy();
    }
  });
});
