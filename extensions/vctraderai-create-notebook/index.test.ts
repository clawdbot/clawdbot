import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { CREATE_NOTEBOOK_TOOL_NAME, runCreateNotebook } from "./index.js";

describe("vctraderai-create-notebook", () => {
  const originalWorkspace = process.env.PFM_WORKSPACE_ID;

  beforeEach(() => {
    process.env.PFM_WORKSPACE_ID = "ws-001";
  });

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.PFM_WORKSPACE_ID;
    else process.env.PFM_WORKSPACE_ID = originalWorkspace;
  });

  it("registers the create_notebook tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-create-notebook" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: CREATE_NOTEBOOK_TOOL_NAME,
      label: "Create Notebook",
    });
  });

  it("posts to the stage path with the create_notebook staging envelope", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = undefined;
    let capturedHeaders = new Headers();
    const notebook = {
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({ staged_action_id: "stg-1" }), { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await runCreateNotebook(
      {
        project_id: "proj-123",
        title: "Compare EURUSD momentum",
        purpose: "Compare three momentum variants before a walk-forward run.",
        template_kind: "compare",
        notebook,
        default_params: { symbol: "EURUSD", timeframe: "H1" },
      },
      { fetchImpl, threadId: "thread-specialist-7" },
    );

    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/stage");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders.get("x-openclaw-thread")).toBe("thread-specialist-7");
    expect(capturedBody.tool_name).toBe("create_notebook");
    expect(capturedBody.workspace_id).toBe("ws-001");
    expect(capturedBody.params).toMatchObject({
      project_id: "proj-123",
      title: "Compare EURUSD momentum",
      template_kind: "compare",
      default_params: { symbol: "EURUSD", timeframe: "H1" },
    });
    expect(capturedBody.params.notebook).toEqual(notebook);
    expect(capturedBody.summary).toBe(
      "Create notebook Compare EURUSD momentum for project proj-123",
    );
    expect(result).toMatchObject({
      message: "Staged a create notebook proposal. Review + Apply it in the chat.",
    });
  });

  it("requires PFM_WORKSPACE_ID before staging a proposal", async () => {
    delete process.env.PFM_WORKSPACE_ID;
    await expect(
      runCreateNotebook({
        project_id: "proj-123",
        title: "Compare EURUSD momentum",
      }),
    ).rejects.toThrow("vctraderai create_notebook: PFM_WORKSPACE_ID is not set");
  });

  it("surfaces a structured error on bff 403 (tool forbidden / not propose_only)", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", {
        status: 403,
        statusText: "Forbidden",
      })) as typeof globalThis.fetch;

    await expect(
      runCreateNotebook(
        {
          project_id: "proj-123",
          title: "Compare EURUSD momentum",
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_403", status: 403 },
    });
  });
});
