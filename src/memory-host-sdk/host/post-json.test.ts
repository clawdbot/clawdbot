import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const { postJson } = await import("./post-json.js");
const { withRemoteHttpResponse } = await import("./remote-http.js");
const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  } as Response;
}

describe("postJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON payload on successful response", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(jsonResponse({ data: [{ embedding: [1, 2] }] }));
    });

    const result = await postJson({
      url: "https://memory.example/v1/post",
      headers: { Authorization: "Bearer test" },
      body: { input: ["x"] },
      errorPrefix: "post failed",
      parse: (payload) => payload,
    });

    expect(result).toEqual({ data: [{ embedding: [1, 2] }] });
  });

  it("attaches status to thrown error when requested", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(textResponse("bad gateway", 502));
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        attachStatus: true,
        parse: () => ({}),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("post failed: 502 bad gateway"),
      status: 502,
    });
  });
});
