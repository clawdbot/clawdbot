import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { runStoreDataset, STORE_DATASET_TOOL_NAME } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-store-dataset", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;
  const originalToken = process.env.PFM_AGENT_TOKEN;
  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = WORKSPACE_ID;
    process.env.PFM_AGENT_TOKEN = "agent-token-001";
  });
  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
    if (originalToken === undefined) delete process.env.PFM_AGENT_TOKEN;
    else process.env.PFM_AGENT_TOKEN = originalToken;
  });

  it("registers store_dataset", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-store-dataset" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: STORE_DATASET_TOOL_NAME });
  });

  it("posts the immutable dataset through the owner-authorized BFF route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { name: "signals" } }), { status: 201 });
    }) as typeof globalThis.fetch;
    await runStoreDataset(
      { name: "signals", content_kind: "structured", content_text: '{"signal":"buy"}' },
      { fetchImpl, threadId: "thread-42" },
    );
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain(`/api/v1/workspaces/${WORKSPACE_ID}/data-vault`);
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
    await expect(request?.json()).resolves.toEqual({
      name: "signals",
      content_kind: "structured",
      content_text: '{"signal":"buy"}',
    });
  });

  it("refuses an ambiguous content shape before opening a request", async () => {
    await expect(runStoreDataset({ name: "signals", content_kind: "structured" })).rejects.toThrow(
      "exactly one",
    );
  });
});
