import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSendNotification } from "./index.js";
import {
  BffEgressViolation,
  createBffFetch,
  VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
} from "./src/internal-http-client.js";

describe("vctraderai-send-notification egress allowlist", () => {
  // This file exercises the real runSendNotification, which reads
  // PFM_WORKSPACE_ID. It used to inherit that variable from whichever sibling
  // test file happened to run first in the same worker, so running this file on
  // its own failed. Own the fixture here.
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.PFM_WORKSPACE_ID;
    } else {
      process.env.PFM_WORKSPACE_ID = originalWorkspace;
    }
  });

  it("the direct-control notifications path is permitted by the allowlist", () => {
    expect("/api/v1/openclaw/notifications/send").toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
  });

  // The allowlist was narrowed when the tool went DIRECT_CONTROL: it no longer
  // needs the generic staging chokepoint or any workspace-scoped surface, so it
  // can no longer reach them. Without this, "narrowed" is an untested claim.
  it("no longer permits the propose-era stage path or workspace-scoped surfaces", () => {
    expect("/api/v1/openclaw/stage").not.toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    expect("/api/v1/openclaw/heartbeat/enable").not.toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    expect("/api/v1/workspaces/00000000-0000-0000-0000-000000000001/notifications").not.toMatch(
      VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN,
    );
  });

  it("every captured url on the happy path matches the allowlist", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runSendNotification({ title: "title-x" } as any, { fetchImpl });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).pathname).toMatch(VCTRADERAI_BFF_ALLOWLIST_PATH_PATTERN);
    }
  });

  it("rejects an internal admin path before a socket opens", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/admin/rpc")).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects relative-traversal segments inside an allowlist-passing prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(bffFetch("/api/v1/openclaw/notifications/../admin")).rejects.toBeInstanceOf(
      BffEgressViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an absolute external URL with a valid-looking prefix", async () => {
    const fetchImpl = vi.fn();
    const bffFetch = createBffFetch({ fetchImpl: fetchImpl as unknown as typeof globalThis.fetch });
    await expect(
      bffFetch("https://evil.example.com/api/v1/openclaw/notifications/send"),
    ).rejects.toBeInstanceOf(BffEgressViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
