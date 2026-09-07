// Docs command tests cover docs lookup, fetch handling, and runtime output.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("../../packages/terminal-core/src/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    command: (s: string) => s,
  },
}));

vi.mock("../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: (path: string, label: string) => `${label}${path}`,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (s: string) => s,
}));

const { docsSearchCommand } = await import("./docs.js");

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv & {
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
  };
}

describe("docsSearchCommand", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("calls the Cloudflare docs search API", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const runtime = makeRuntime();

    await docsSearchCommand(["plugin", "allowlist"], runtime);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = expectDefined(
      fetchMock.mock.calls[0],
      "fetchMock.mock.calls[0] test invariant",
    );
    if (!(url instanceof URL)) {
      throw new Error("expected docs search to call fetch with a URL");
    }
    expect(url.href).toBe("https://docs.openclaw.ai/api/search?q=plugin+allowlist");
    expect(init).toMatchObject({ headers: { Accept: "application/json" } });
  });

  it("emits one JSON object for search results", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "CLI reference",
              link: "https://docs.openclaw.ai/cli",
              snippet: "Command-line usage",
            },
          ],
        }),
      ),
    );
    const runtime = makeRuntime();

    await docsSearchCommand(["cli"], runtime, { json: true });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      query: "cli",
      results: [
        {
          title: "CLI reference",
          link: "https://docs.openclaw.ai/cli",
          snippet: "Command-line usage",
        },
      ],
    });
  });

  it("limits normalized search results before rendering", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: "Invalid result without a link" },
            { title: "CLI reference", link: "https://docs.openclaw.ai/cli" },
            { title: "Plugin guide", link: "https://docs.openclaw.ai/plugins" },
          ],
        }),
      ),
    );
    const runtime = makeRuntime();

    await docsSearchCommand(["openclaw"], runtime, { json: true, limit: 1 });

    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      query: "openclaw",
      results: [{ title: "CLI reference", link: "https://docs.openclaw.ai/cli" }],
    });
  });

  it("emits one JSON object for the docs homepage", async () => {
    const runtime = makeRuntime();

    await docsSearchCommand([], runtime, { json: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      query: null,
      url: "https://docs.openclaw.ai/",
      results: [],
    });
  });

  it("cancels non-OK docs search response bodies and fails loudly", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unavailable"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
    fetchMock.mockResolvedValueOnce(response);
    const runtime = makeRuntime();

    await expect(docsSearchCommand(["browser", "existing-session"], runtime)).rejects.toThrow(
      "Docs search failed: HTTP 503",
    );

    expect(cancelled).toBe(true);
  });

  it("reports malformed docs search JSON with CLI context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{bad json", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const runtime = makeRuntime();

    await expect(docsSearchCommand(["bad-json"], runtime)).rejects.toThrow(
      "Docs search failed: Docs search response is malformed JSON",
    );
  });

  it("reports docs search responses with invalid UTF-8 bytes as malformed", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"results":[{"title":"Plugin allow'),
      0xff,
      ...new TextEncoder().encode('list","link":"https://docs.openclaw.ai/plugins/allowlist"}]}'),
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    const runtime = makeRuntime();

    await expect(docsSearchCommand(["plugin"], runtime)).rejects.toThrow(
      "Docs search failed: Docs search response is malformed JSON",
    );
  });

  it("renders successful results from the Cloudflare docs search API", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Plugin allowlist",
              link: "https://docs.openclaw.ai/plugins/allowlist",
              snippet: "How to configure the allowlist.",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    const runtime = makeRuntime();

    await docsSearchCommand(["plugin", "allowlist"], runtime);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });

  it("rejects oversized docs search responses", async () => {
    const ONE_MIB = 1024 * 1024;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        for (let i = 0; i < 10; i++) {
          controller.enqueue(new Uint8Array(ONE_MIB));
        }
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const runtime = makeRuntime();

    await expect(docsSearchCommand(["oversized"], runtime)).rejects.toThrow(
      "Docs search failed: Docs search response exceeds 8388608 bytes",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
