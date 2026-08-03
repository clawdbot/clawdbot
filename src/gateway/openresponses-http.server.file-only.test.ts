import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const extractFileContentFromSourceMock = vi.fn();

vi.mock("../media/input-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/input-files.js")>("../media/input-files.js");
  return {
    ...actual,
    extractFileContentFromSource: (...args: unknown[]) => extractFileContentFromSourceMock(...args),
  };
});

import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];
let port: number;

beforeAll(async () => {
  const started = await startGatewayServerWithRetries({
    port: await getFreePort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    },
  });
  port = started.port;
  server = started.server;
});

afterAll(async () => {
  await server?.close({ reason: "openresponses file-only suite done" });
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function postResponses(body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify(body),
  });
}

describe("OpenResponses file-only input that renders to images", () => {
  it("accepts a file-only turn whose file renders to images and forwards them", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "scan.pdf",
      text: "",
      images: [
        { type: "image", data: Buffer.alloc(8, 1).toString("base64"), mimeType: "image/png" },
      ],
    });
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

    const res = await postResponses({
      model: "openclaw",
      instructions: "Describe the attached scan.",
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
                data: Buffer.from("%PDF-1.4 scanned").toString("base64"),
                filename: "scan.pdf",
              },
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(agentCommand).toHaveBeenCalledTimes(1);
    const opts = agentCommand.mock.calls[0]?.[0] as { message?: string; images?: unknown[] };
    expect(opts.message ?? "").not.toBe("");
    expect(opts.images?.length).toBe(1);
    await res.text();
  });

  it("keeps an empty extracted file visible to the model", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "empty.txt",
      text: "",
      images: [],
    });
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

    const res = await postResponses({
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
                media_type: "text/plain",
                data: Buffer.from("binary-only file").toString("base64"),
                filename: "empty.txt",
              },
            },
          ],
        },
      ],
    });

    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(agentCommand).toHaveBeenCalledTimes(1);
    const opts = agentCommand.mock.calls[0]?.[0] as { extraSystemPrompt?: string };
    expect(opts.extraSystemPrompt).toContain('<file name="empty.txt">');
    expect(opts.extraSystemPrompt).toContain("[No extractable text]");
  });
});
