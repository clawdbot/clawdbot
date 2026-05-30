import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, { runGetDataRoot, GET_DATA_ROOT_TOOL_NAME } from "./index.js";

describe("vctraderai-get-data-root", () => {
  it("registers the get_data_root tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({ id: "vctraderai-get-data-root" });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_DATA_ROOT_TOOL_NAME,
      label: "Get Data Root",
    });
  });

  it("returns the data-root envelope verbatim on the happy path", async () => {
    const envelope = {
      root: "s3://pfm-staging-data/curated",
      exists: true,
      key_subfolders: ["s3://pfm-staging-data/curated/provider=dukascopy/"],
      providers: ["dukascopy"],
      sources: ["s3://pfm-staging-data/curated"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetDataRoot({ fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the workspace-agnostic data root path with GET", async () => {
    let capturedUrl = "";
    let capturedMethod: string | undefined = undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedMethod = init?.method;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetDataRoot({ fetchImpl });
    expect(new URL(capturedUrl).pathname).toBe("/api/v1/openclaw/data/root");
    expect(capturedMethod).toBe("GET");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetDataRoot({ fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
