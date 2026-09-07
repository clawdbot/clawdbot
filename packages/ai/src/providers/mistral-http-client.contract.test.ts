import { Mistral } from "@mistralai/mistralai";
import { HTTPClient } from "@mistralai/mistralai/lib/http";
import { Chat } from "@mistralai/mistralai/sdk/chat";
import { describe, expect, it, vi } from "vitest";

describe("Mistral HTTPClient contract", () => {
  it.each([
    {
      name: "root client",
      createChat: (options: ConstructorParameters<typeof Chat>[0]) => new Mistral(options).chat,
    },
    {
      name: "chat subclient",
      createChat: (options: ConstructorParameters<typeof Chat>[0]) => new Chat(options),
    },
  ])("routes $name responses through the injected HTTPClient hooks", async ({ createChat }) => {
    const response = new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetcher = vi.fn(async () => response);
    const onResponse = vi.fn();
    const httpClient = new HTTPClient({ fetcher });
    httpClient.addHook("response", onResponse);
    const chat = createChat({
      apiKey: "test-key",
      serverURL: "https://mistral.invalid",
      httpClient,
    });

    const stream = await chat.stream({
      model: "mistral-test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(response, expect.any(Request));
    await stream.cancel("test complete");
  });
});
