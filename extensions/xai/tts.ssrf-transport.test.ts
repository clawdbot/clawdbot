import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { listXaiTtsVoices, xaiTTS } from "./tts.js";

const audio = Buffer.from("ID3fake-mp3-body");
const voices = [{ id: "alpha", name: "Alpha", locale: undefined, gender: undefined }];

const operations = [
  {
    name: "synthesis",
    method: "POST",
    path: "/v1/tts",
    contentType: "audio/mpeg",
    body: audio,
    expected: audio,
    request: (baseUrl: string) =>
      xaiTTS({ text: "hello", apiKey: "test-key", baseUrl, voiceId: "voice", timeoutMs: 5000 }),
  },
  {
    name: "voice discovery",
    method: "GET",
    path: "/v1/tts/voices",
    contentType: "application/json",
    body: JSON.stringify({ voices: [{ voice_id: "alpha", name: "Alpha" }] }),
    expected: voices,
    request: (baseUrl: string) => listXaiTtsVoices({ apiKey: "test-key", baseUrl }),
  },
];

describe.each(operations)("xAI $name guarded transport", (operation) => {
  it("reaches the configured private origin", async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
    await withServer(
      (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": operation.contentType });
        response.end(operation.body);
      },
      async (origin) => {
        await expect(operation.request(`${origin}/v1/`)).resolves.toEqual(operation.expected);
        expect(requests).toEqual([
          { method: operation.method, url: operation.path, authorization: "Bearer test-key" },
        ]);
      },
    );
  });

  it("rejects a different private origin before contacting it", async () => {
    let sourceRequests = 0;
    let targetRequests = 0;
    await withServer(
      (_request, response) => {
        targetRequests += 1;
        response.writeHead(200, { "content-type": operation.contentType });
        response.end(operation.body);
      },
      async (target) => {
        await withServer(
          (_request, response) => {
            sourceRequests += 1;
            response.writeHead(302, { location: `${target}${operation.path}` });
            response.end();
          },
          async (origin) => {
            await expect(operation.request(`${origin}/v1`)).rejects.toBeInstanceOf(
              SsrFBlockedError,
            );
            expect(sourceRequests).toBe(1);
            expect(targetRequests).toBe(0);
          },
        );
      },
    );
  });
});
