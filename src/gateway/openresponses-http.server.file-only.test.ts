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

const PNG_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

function createInputImage() {
  return {
    type: "input_image",
    source: { type: "base64", media_type: "image/png", data: PNG_IMAGE_BASE64 },
  } as const;
}

function createInputFile(filename: string) {
  return {
    type: "input_file",
    source: {
      type: "base64",
      media_type: "text/plain",
      data: Buffer.from(`contents of ${filename}`).toString("base64"),
      filename,
    },
  } as const;
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

  it.each([
    {
      name: "a newer user message",
      followup: { type: "message", role: "user", content: "Describe the previous answer." },
      expectedCurrentMessage: "Describe the previous answer.",
    },
    {
      name: "a terminal client-tool result",
      followup: {
        type: "function_call_output",
        call_id: "call_lookup",
        output: "The previous answer was accepted.",
      },
      expectedCurrentMessage: "The previous answer was accepted.",
    },
  ])("does not replay historical attachments after $name", async (testCase) => {
    extractFileContentFromSourceMock.mockResolvedValue({
      filename: "historical.txt",
      text: "historical file contents",
      images: [],
    });
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

    const res = await postResponses({
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [createInputImage(), createInputFile("historical.txt")],
        },
        { type: "message", role: "assistant", content: "I inspected the attachments." },
        testCase.followup,
      ],
    });

    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
    expect(agentCommand).toHaveBeenCalledTimes(1);
    const opts = agentCommand.mock.calls[0]?.[0] as {
      message?: string;
      images?: unknown[];
      extraSystemPrompt?: string;
    };
    expect(opts.message).toContain(testCase.expectedCurrentMessage);
    expect(opts.message).not.toContain("User sent image(s) with no text.");
    expect(opts.images).toBeUndefined();
    expect(opts.extraSystemPrompt ?? "").not.toContain("historical.txt");
  });

  it("extracts attachments only from the latest active user message", async () => {
    extractFileContentFromSourceMock.mockImplementation(
      async ({ source }: { source: { filename?: string } }) => ({
        filename: source.filename,
        text: `contents of ${source.filename}`,
        images: [],
      }),
    );
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

    const res = await postResponses({
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect the first attachments." },
            createInputImage(),
            createInputFile("historical.txt"),
          ],
        },
        { type: "message", role: "assistant", content: "The first attachments were inspected." },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect only the current attachments." },
            createInputImage(),
            createInputFile("current.txt"),
          ],
        },
      ],
    });

    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(extractFileContentFromSourceMock).toHaveBeenCalledTimes(1);
    const opts = agentCommand.mock.calls[0]?.[0] as {
      images?: unknown[];
      extraSystemPrompt?: string;
    };
    expect(opts.images).toHaveLength(1);
    expect(opts.extraSystemPrompt).toContain("current.txt");
    expect(opts.extraSystemPrompt).not.toContain("historical.txt");
  });

  it.each(["system", "developer", "assistant"] as const)(
    "ignores attachments belonging to a historical %s message",
    async (role) => {
      extractFileContentFromSourceMock.mockResolvedValue({
        filename: "not-user-owned.txt",
        text: "should not become current input",
        images: [],
      });
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

      const res = await postResponses({
        model: "openclaw",
        input: [
          {
            type: "message",
            role,
            content: [
              { type: "input_text", text: "Earlier non-user context." },
              createInputImage(),
              createInputFile("not-user-owned.txt"),
            ],
          },
          { type: "message", role: "user", content: "Answer this current question." },
        ],
      });

      const body = await res.text();
      expect(res.status, body).toBe(200);
      expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
      const opts = agentCommand.mock.calls[0]?.[0] as {
        images?: unknown[];
        extraSystemPrompt?: string;
      };
      expect(opts.images).toBeUndefined();
      expect(opts.extraSystemPrompt ?? "").not.toContain("not-user-owned.txt");
    },
  );

  it.each(["input_image", "input_file"] as const)(
    "does not fetch a historical %s URL on a newer text-only turn",
    async (type) => {
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

      const res = await postResponses({
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type, source: { type: "url", url: "https://example.com/historical" } }],
          },
          { type: "message", role: "user", content: "Answer without fetching history." },
        ],
      });

      const body = await res.text();
      expect(res.status, body).toBe(200);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
    },
  );

  it("counts historical image and file URLs against the request-wide source limit", async () => {
    const historicalParts = Array.from({ length: 9 }, (_, index) => ({
      type: index % 2 === 0 ? "input_image" : "input_file",
      source: { type: "url", url: `https://example.com/historical-${index}` },
    }));

    const res = await postResponses({
      model: "openclaw",
      input: [
        { type: "message", role: "user", content: historicalParts },
        { type: "message", role: "user", content: "Answer without fetching history." },
      ],
    });

    expect(res.status).toBe(400);
    expect(agentCommand).not.toHaveBeenCalled();
    expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
    await res.text();
  });
});
