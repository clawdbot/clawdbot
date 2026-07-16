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

  it("fails loudly when the Cloudflare docs search API fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    const runtime = makeRuntime();

    await docsSearchCommand(["browser", "existing-session"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports malformed docs search JSON with CLI context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{bad json", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const runtime = makeRuntime();

    await docsSearchCommand(["bad-json"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Docs search failed: Docs search response is malformed JSON",
    );
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.exit).toHaveBeenCalledWith(1);
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

    await docsSearchCommand(["oversized"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Docs search response exceeds"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
