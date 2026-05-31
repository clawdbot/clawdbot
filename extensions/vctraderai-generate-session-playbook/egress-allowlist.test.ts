import { describe, expect, it, vi } from "vitest";
import { runGenerateSessionPlaybook } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

describe("vctraderai-generate-session-playbook egress allowlist", () => {
  it("every captured url on the happy path matches the allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGenerateSessionPlaybook(
      { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
      { fetchImpl },
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects an internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/internal/admin/secrets", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an attempt to call the gateway-protocol admin surface", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/admin/rpc", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects relative-traversal segments inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/playbooks/../admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects newline / null-byte injection inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("/api/v1/openclaw/playbooks/session\nGET /admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    await expect(
      bffFetch("/api/v1/openclaw/playbooks/session\0/admin", { method: "POST", body: {} }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking openclaw prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("https://evil.example.com/api/v1/openclaw/playbooks/session", {
        method: "POST",
        body: {},
      }),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an aborted fetch via AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    controller.abort();
    await expect(
      runGenerateSessionPlaybook(
        { workspace_id: "33333333-3333-3333-3333-333333333333", session: "LONDON" },
        { fetchImpl },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
