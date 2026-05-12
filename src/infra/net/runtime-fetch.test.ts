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

function requireFetchInit(mock: ReturnType<typeof vi.fn>): RequestInit {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected runtime fetch call");
  }
  const init = call[1];
  if (typeof init !== "object" || init === null || Array.isArray(init)) {
    throw new Error("expected runtime fetch init");
  }
  return init as RequestInit;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithRuntimeDispatcher", () => {
  it("drops symbol metadata from plain header dictionaries before runtime fetch", async () => {
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      return new Response("ok", { status: 200 });
    });

    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      FormData: RuntimeFormData,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    const headers = { "Content-Type": "application/json" } as Record<string, string> & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });

    const response = await fetchWithRuntimeDispatcher("https://example.com/json", {
      method: "POST",
      headers,
      body: "{}",
    });

    expect(response.status).toBe(200);
    const sentHeaders = requireFetchInit(runtimeFetch).headers;
    expect(sentHeaders).not.toBe(headers);
    expect(Object.getOwnPropertySymbols(sentHeaders as object)).toStrictEqual([]);
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });

  it("normalizes global FormData bodies into the runtime FormData implementation", async () => {
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // init.body was rebuilt as RuntimeFormData by normalizeRuntimeFormData;
      // BodyInit and RuntimeFormData live in separate type namespaces so a double cast is needed.
      const body = init?.body as unknown as RuntimeFormData;
      expect(body).toBeInstanceOf(RuntimeFormData);
      const modelRecord = body.records.find((record) => record.name === "model");
      expect(modelRecord?.value).toBe("gpt-4o-transcribe");
      const fileRecord = body.records.find((record) => record.name === "file");
      expect(fileRecord?.filename).toBe("clip.ogg");
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
    const sentInit = requireFetchInit(runtimeFetch);
    const sentHeaders = new Headers(sentInit.headers);
    expect(sentHeaders.has("content-length")).toBe(false);
    expect(sentHeaders.has("content-type")).toBe(false);
  });
});
