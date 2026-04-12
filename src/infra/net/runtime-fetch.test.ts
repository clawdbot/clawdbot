import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

class RuntimeFormData {
  readonly records: Array<{
    name: string;
    value: unknown;
    filename?: string;
  }> = [];

  append(name: string, value: unknown, filename?: string): void {
    this.records.push({
      name,
      value,
      ...(typeof filename === "string" ? { filename } : {}),
    });
  }

  *entries(): IterableIterator<[string, unknown]> {
    for (const record of this.records) {
      yield [record.name, record.value];
    }
  }

  get [Symbol.toStringTag](): string {
    return "FormData";
  }
}

class MockAgent {
  readonly __testStub = true;
}

class MockEnvHttpProxyAgent {
  readonly __testStub = true;
}

class MockProxyAgent {
  readonly __testStub = true;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithRuntimeDispatcher", () => {
  it("normalizes global FormData bodies into the runtime FormData implementation", async () => {
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // init.body was rebuilt as RuntimeFormData by normalizeRuntimeFormData;
      // BodyInit and RuntimeFormData live in separate type namespaces so a double cast is needed.
      const body = init?.body as unknown as RuntimeFormData;
      expect(body).toBeInstanceOf(RuntimeFormData);
      expect(body.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            value: "gpt-4o-transcribe",
          }),
          expect.objectContaining({
            name: "file",
            filename: "clip.ogg",
          }),
        ]),
      );
      return new Response("ok", { status: 200 });
    });

    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      FormData: RuntimeFormData,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "clip.ogg");
    form.append("model", "gpt-4o-transcribe");

    const response = await fetchWithRuntimeDispatcher("https://example.com/upload", {
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "multipart/form-data; boundary=stale",
      },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const sentInit = runtimeFetch.mock.calls[0]?.[1] as RequestInit;
    const sentHeaders = new Headers(sentInit.headers);
    expect(sentHeaders.has("content-length")).toBe(false);
    expect(sentHeaders.has("content-type")).toBe(false);
  });
});
