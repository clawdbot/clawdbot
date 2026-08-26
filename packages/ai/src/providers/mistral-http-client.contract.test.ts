import { HTTPClient, Mistral } from "@mistralai/mistralai";
import { describe, expect, it, vi } from "vitest";

describe("Mistral HTTPClient contract", () => {
  it("routes chat.stream responses through the injected HTTPClient hooks", async () => {
    const response = new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetcher = vi.fn(async () => response);
    const onResponse = vi.fn();
    const httpClient = new HTTPClient({ fetcher });
    httpClient.addHook("response", onResponse);
    const mistral = new Mistral({
      apiKey: "test-key",
      serverURL: "https://mistral.invalid",
      httpClient,
    });

    const stream = await mistral.chat.stream({
      model: "mistral-test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(response, expect.any(Request));
    await stream.cancel("test complete");
  });
});
