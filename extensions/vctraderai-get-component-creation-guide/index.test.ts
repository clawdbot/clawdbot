import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin, {
  runGetComponentCreationGuide,
  GET_COMPONENT_CREATION_GUIDE_TOOL_NAME,
} from "./index.js";

describe("vctraderai-get-component-creation-guide", () => {
  it("registers the get_component_creation_guide tool with the plugin api", () => {
    const captured = createCapturedPluginRegistration({
      id: "vctraderai-get-component-creation-guide",
    });
    plugin.register(captured.api);
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: GET_COMPONENT_CREATION_GUIDE_TOOL_NAME,
      label: "Get Component Creation Guide",
    });
  });

  it("returns the catalogue envelope verbatim on the happy path", async () => {
    const envelope = {
      sections: [
        {
          title: "Creating a Strategy",
          body: "...",
        },
        {
          title: "Creating an Indicator",
          body: "...",
        },
      ],
      sources: ["postgres://core.docs"],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const result = await runGetComponentCreationGuide({ fetchImpl });
    expect(result).toEqual(envelope);
  });

  it("calls the catalogue path with no query parameters", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;
    await runGetComponentCreationGuide({ fetchImpl });
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/v1/openclaw/catalogue/component-creation-guide");
    expect(parsed.searchParams.toString()).toBe("");
  });

  it("surfaces a structured error on bff 500", async () => {
    const fetchImpl = (async () =>
      new Response("server error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as typeof globalThis.fetch;
    await expect(runGetComponentCreationGuide({ fetchImpl })).rejects.toMatchObject({
      name: "BffRequestError",
      detail: { code: "bff_500", status: 500 },
    });
  });
});
