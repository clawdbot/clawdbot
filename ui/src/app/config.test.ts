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

function bootstrapResponse(
  serverVersion: string,
  automaticallyFetchFavicons = false,
  pluginAssetsRequireAuth?: boolean,
  communityInvite = true,
): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    cliAgentsEnabled: true,
    automaticallyFetchFavicons,
    communityInvite,
    ...(pluginAssetsRequireAuth === undefined ? {} : { pluginAssetsRequireAuth }),
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
  it("keeps invitations hidden until bootstrap enables them and accepts later opt-outs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(bootstrapResponse("test"))
      .mockResolvedValueOnce(bootstrapResponse("test", false, undefined, false));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const listener = vi.fn();
    const unsubscribe = config.subscribe(listener);

    expect(config.current.communityInvite).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: true });
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ communityInvite: false }));
    unsubscribe();
  });

  it.each([undefined, true, false])(
    "requires native asset grants unless bootstrap explicitly disables auth: %s",
    async (pluginAssetsRequireAuth) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => bootstrapResponse("test", false, pluginAssetsRequireAuth)),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      expect(config.current.pluginAssetsRequireAuth).toBe(true);
      await expect(config.refresh()).resolves.toMatchObject({
        pluginAssetsRequireAuth: pluginAssetsRequireAuth !== false,
        pluginFrameGrants: [],
      });
    },
  );

  it("stays fail closed before bootstrap and accepts the Gateway favicon setting", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("test", true));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/openclaw" });

    expect(config.current.automaticallyFetchFavicons).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ automaticallyFetchFavicons: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/openclaw/control-ui-config.json");
    expect(config.current.automaticallyFetchFavicons).toBe(true);
  });

  it.each([null, { pluginFrameGrants: {} }])(
    "returns an unavailable result for invalid bootstrap data: %j",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload))),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });

      await expect(config.refresh()).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
    },
  );

  it("does not discard an in-flight bootstrap when an auth-only refresh skips", async () => {
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => response.promise),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    const loading = config.refresh();
    await expect(config.refresh({ skipWithoutAuthCandidate: true })).resolves.toBeNull();
    response.resolve(bootstrapResponse("ready", false, false));

    await expect(loading).resolves.toMatchObject({ serverVersion: "ready" });
    expect(config.current.serverVersion).toBe("ready");
  });

  it("shares concurrent bootstrap loads with equivalent credentials", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const first = config.refresh();
    token = " fixture-token ";
    const second = config.refresh({ skipWithoutAuthCandidate: true });
    response.resolve(bootstrapResponse("ready"));

    await expect(first).resolves.toMatchObject({ serverVersion: "ready" });
    await expect(second).resolves.toMatchObject({ serverVersion: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an authenticated response after credentials are cleared by a skipped refresh", async () => {
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => response.promise),
    );
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const loading = config.refresh();
    token = "";
    await expect(config.refresh({ skipWithoutAuthCandidate: true })).resolves.toBeNull();
    response.resolve(bootstrapResponse("old"));

    await expect(loading).resolves.toBeNull();
    expect(config.current.serverVersion).toBeNull();
  });

  it.each(["", "replacement-fixture-token"])(
    "rejects an authenticated response when live credentials change without another refresh: %s",
    async (nextToken) => {
      const response = deferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      let token = "fixture-token";
      const config = createApplicationConfigCapability({
        resourceBasePath: "",
        getAuth: () => ({ settings: { token } }),
      });

      const loading = config.refresh();
      token = nextToken;
      response.resolve(bootstrapResponse("retired"));

      await expect(loading).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps independent callers valid and publishes the newest successful response (aborted: %s)",
    async (aborted) => {
      const firstResponse = deferred<Response>();
      const secondResponse = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockImplementationOnce(() => firstResponse.promise)
          .mockImplementationOnce(() => secondResponse.promise),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      const abort = new AbortController();
      const first = config.refresh();
      const second = config.refresh({ signal: abort.signal });
      if (aborted) {
        abort.abort();
      }
      secondResponse.resolve(bootstrapResponse("new"));
      expect(await second).toEqual(
        aborted ? null : expect.objectContaining({ serverVersion: "new" }),
      );
      firstResponse.resolve(bootstrapResponse("old"));

      await expect(first).resolves.toMatchObject({ serverVersion: "old" });
      expect(config.current.serverVersion).toBe(aborted ? "old" : "new");
    },
  );

  it("returns null for a bootstrap response superseded by different credentials", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "old-fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const firstRefresh = config.refresh();
    token = "new-fixture-token";
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
    expect(config.current.cliAgentsEnabled).toBe(true);
  });
});
