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

function bootstrapResponse(serverVersion: string, automaticallyFetchFavicons = false): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    cliAgentsEnabled: true,
    automaticallyFetchFavicons,
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
  it("stays fail closed before bootstrap and accepts the Gateway favicon setting", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("test", true));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/openclaw" });

    expect(config.current.automaticallyFetchFavicons).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ automaticallyFetchFavicons: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/openclaw/control-ui-config.json");
    expect(config.current.automaticallyFetchFavicons).toBe(true);
  });

  it("returns null for a superseded bootstrap response", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    const firstRefresh = config.refresh();
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
    expect(config.current.cliAgentsEnabled).toBe(true);
  });
});
