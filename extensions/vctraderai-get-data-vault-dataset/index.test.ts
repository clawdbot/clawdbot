import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { GET_DATA_VAULT_DATASET_TOOL_NAME, runGetDataVaultDataset } from "./index.js";

const WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";

describe("vctraderai-get-data-vault-dataset", () => {
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

  it("registers get_data_vault_dataset", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-data-vault-dataset" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({ name: GET_DATA_VAULT_DATASET_TOOL_NAME });
  });

  it("uses a URL-encoded, owner-authorized bounded preview route", async () => {
    let request: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: { rows: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetDataVaultDataset({ name: "daily signals/2026", rows: 25 }, { fetchImpl });
    expect(request?.method).toBe("GET");
    expect(request?.url).toContain(
      `/api/v1/workspaces/${WORKSPACE_ID}/data-vault/daily%20signals%2F2026/preview?rows=25`,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer agent-token-001");
  });
});
