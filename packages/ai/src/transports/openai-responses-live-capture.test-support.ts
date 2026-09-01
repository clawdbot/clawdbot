export async function captureOpenAIResponses<T>(run: () => Promise<T>): Promise<{
  result: T;
  requests: Array<Record<string, unknown>>;
  responseTexts: string[];
}> {
  const requests: Array<Record<string, unknown>> = [];
  const captures: Array<Promise<{ text: string } | { error: unknown }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== "https://api.openai.com" || url.pathname !== "/v1/responses") {
      return realFetch(input, init);
    }
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON Responses request body");
    }
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = await realFetch(input, init);
    // Await the clone before assertions; preserve the SDK's original response and stream.
    captures.push(
      response
        .clone()
        .text()
        .then(
          (text) => ({ text }),
          (error: unknown) => ({ error }),
        ),
    );
    return response;
  };
  try {
    const result = await run();
    const responseTexts = (await Promise.all(captures)).map((capture) => {
      if ("error" in capture) {
        throw new Error("Responses wire capture failed", { cause: capture.error });
      }
      return capture.text;
    });
    return { result, requests, responseTexts };
  } finally {
    globalThis.fetch = realFetch;
  }
}
