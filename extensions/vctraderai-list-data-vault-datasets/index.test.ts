import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { LIST_DATA_VAULT_DATASETS_TOOL_NAME, runListDataVaultDatasets } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-list-data-vault-datasets", () => {
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

  it("registers list_data_vault_datasets", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-list-data-vault-datasets",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: LIST_DATA_VAULT_DATASETS_TOOL_NAME });
  });

  it("uses the owner-authorized workspace catalogue route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { datasets: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runListDataVaultDatasets({ limit: 50 }, { fetchImpl, threadId: "thread-42" });
    expect(request?.method).toBe("GET");
    expect(request?.url).toContain(`/api/v1/workspaces/${WORKSPACE_ID}/data-vault?limit=50`);
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
    expect(request?.headers.get("x-openclaw-thread")).toBe("thread-42");
  });
});
