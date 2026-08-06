import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-contract.js";
import { createApplicationConfigCapability } from "./config.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function bootstrapResponse(serverVersion: string): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    pluginFrameGrants: [],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApplicationConfigCapability", () => {
  it("returns null for a superseded bootstrap response", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    const firstRefresh = config.refresh();
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
  });
});
