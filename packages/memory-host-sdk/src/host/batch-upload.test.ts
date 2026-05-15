import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  } as Response;
}

describe("uploadBatchJsonlFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps malformed file-upload JSON with the request error prefix", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(textResponse("{ nope", 200));
    });

    await expect(
      uploadBatchJsonlFile({
        client: {
          baseUrl: "https://memory.example/v1",
          headers: { Authorization: "Bearer test" },
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      }),
    ).rejects.toThrow("file upload failed: malformed JSON response");
  });
});
