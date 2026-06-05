// Openai Image Auth Docker Client tests cover openai image auth docker client script behavior.
import { describe, expect, it } from "vitest";
import {
  startMockServer,
  type RequestRecord,
} from "../../scripts/e2e/openai-image-auth-docker-client.ts";

describe("OpenAI image auth Docker client mock server", () => {
  it("rejects oversized request bodies before recording them", async () => {
    const previousLimit = process.env.OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES;
    process.env.OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES = "4";
    const records: RequestRecord[] = [];
    const server = await startMockServer(records);
    try {
      const response = await fetch(`${server.baseUrl}/v1/images/generations`, {
        method: "POST",
        body: "too large",
      });

      await expect(response.json()).resolves.toEqual({
        error: { message: "mock OpenAI request body exceeded 4 bytes" },
      });
      expect(response.status).toBe(413);
      expect(records).toEqual([]);
    } finally {
      await server.close();
      if (previousLimit === undefined) {
        delete process.env.OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES;
      } else {
        process.env.OPENCLAW_MOCK_OPENAI_REQUEST_MAX_BYTES = previousLimit;
      }
    }
  });
});
