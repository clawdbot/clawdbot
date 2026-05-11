import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./constants.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  cleanupBrowserControlServerTestContext,
  getBrowserControlServerBaseUrl,
  getBrowserControlServerTestState,
  getCdpMocks,
  getPwMocks,
  makeResponse,
  resetBrowserControlServerTestContext,
  setBrowserControlServerEvaluateEnabled,
  setBrowserControlServerProfiles,
  setBrowserControlServerReachable,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-support/fetch.js";

type ActErrorResponse = {
  error?: string;
  code?: string;
};

type ActErrorHttpResponse = {
  status: number;
  body: ActErrorResponse;
};

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toBeDefined();
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  const actual = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
}

async function postActAndReadError(base: string, body?: unknown): Promise<ActErrorHttpResponse> {
  const realFetch = getBrowserTestFetch();
  const response = await realFetch(`${base}/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ActErrorResponse,
  };
}

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installAgentContractHooks();

  const slowTimeoutMs = 60_000;

  it(
    "returns ACT_KIND_REQUIRED when kind is missing",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_KIND_REQUIRED");
      expect(response.body.error).toContain("kind is required");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_INVALID_REQUEST for malformed action payloads",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "click",
        ref: {},
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_INVALID_REQUEST");
      expect(response.body.error).toContain("click requires ref or selector");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_INVALID_REQUEST for malformed coordinate clicks",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "clickCoords",
        x: -1,
        y: 20,
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_INVALID_REQUEST");
      expect(response.body.error).toContain("clickCoords requires non-negative x and y");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_EXISTING_SESSION_UNSUPPORTED for unsupported existing-session actions",
    async () => {
      setBrowserControlServerProfiles({
        openclaw: {
          color: "#FF4500",
          driver: "existing-session",
        },
      });

      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "batch",
        actions: [{ kind: "press", key: "Enter" }],
      });

      expect(response.status).toBe(501);
      expect(response.body.code).toBe("ACT_EXISTING_SESSION_UNSUPPORTED");
      expect(response.body.error).toContain("batch");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_TARGET_ID_MISMATCH for batched action targetId overrides",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "batch",
        actions: [{ kind: "click", ref: "5", targetId: "other-tab" }],
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(response.body.error).toContain("batched action targetId must match request targetId");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_TARGET_ID_MISMATCH for top-level action targetId overrides",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "click",
        ref: "5",
        // Intentionally non-string: route-level target selection ignores this,
        // while action normalization stringifies it.
        targetId: 12345,
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_TARGET_ID_MISMATCH");
      expect(response.body.error).toContain("action targetId must match request targetId");
    },
    slowTimeoutMs,
  );

  it(
    "returns the replacement targetId after an action-triggered target swap",
    async () => {
      const base = await startServerAndBase();
      pwMocks.clickViaPlaywright.mockImplementationOnce(async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string) => {
            if (url.includes("/json/list")) {
              return makeResponse([
                {
                  id: "fresh5678",
                  title: "Submitted",
                  url: "https://submitted.example",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/fresh5678",
                  type: "page",
                },
              ]);
            }
            throw new Error(`unexpected fetch: ${url}`);
          }),
        );
      });

      const response = await postJson<{ ok: boolean; targetId?: string }>(`${base}/act`, {
        kind: "click",
        ref: "5",
        targetId: "abcd1234",
      });

      expect(response.ok).toBe(true);
      expect(response.targetId).toBe("fresh5678");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_SELECTOR_UNSUPPORTED for selector on unsupported action kinds",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "evaluate",
        fn: "() => 1",
        selector: "#submit",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_SELECTOR_UNSUPPORTED");
      expect(response.body.error).toContain("'selector' is not supported");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_INVALID_REQUEST for malformed unsupported selector actions before selector gating",
    async () => {
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "press",
        selector: "#submit",
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("ACT_INVALID_REQUEST");
      expect(response.body.error).toContain("press requires key");
    },
    slowTimeoutMs,
  );

  it(
    "returns ACT_EVALUATE_DISABLED when evaluate is blocked by config",
    async () => {
      setBrowserControlServerEvaluateEnabled(false);
      const base = await startServerAndBase();
      const response = await postActAndReadError(base, {
        kind: "evaluate",
        fn: "() => 1",
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("ACT_EVALUATE_DISABLED");
      expect(response.body.error).toContain("browser.evaluateEnabled=false");
    },
    slowTimeoutMs,
  );
  it("agent contract: snapshot endpoints", async () => {
    const base = await startServerAndBase();
    const realFetch = getBrowserTestFetch();

    const snapAria = (await realFetch(`${base}/snapshot?format=aria&limit=1`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 1,
    });
    expect(pwMocks.storeAriaSnapshotRefsViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      nodes: [{ ref: "1", role: "link", name: "x", depth: 0 }],
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });

    const snapAiZero = (await realFetch(`${base}/snapshot?format=ai&maxChars=0`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAiZero.ok).toBe(true);
    expect(snapAiZero.format).toBe("ai");
    const [lastCall] = pwMocks.snapshotAiViaPlaywright.mock.calls.at(-1) ?? [];
    expect(lastCall).toEqual({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });

    pwMocks.snapshotRoleViaPlaywright.mockRejectedValueOnce(new Error("playwright stale page"));
    const fallback = (await realFetch(`${base}/snapshot?format=ai&interactive=true`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string; snapshot?: string };
    expect(fallback.ok).toBe(true);
    expect(fallback.format).toBe("ai");
    expect(fallback.snapshot).toContain("Fallback");
    expect(cdpMocks.snapshotRoleViaCdp).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      urls: undefined,
      options: {
        interactive: true,
        compact: undefined,
        maxDepth: undefined,
      },
    });
  });

  it("agent contract: doctor deep runs a live snapshot probe", async () => {
    const base = await startServerAndBase();
    const realFetch = getBrowserTestFetch();

    const report = (await realFetch(`${base}/doctor?deep=true`).then((r) => r.json())) as {
      ok: boolean;
      checks?: Array<{ id?: string; status?: string; summary?: string }>;
    };

    expect(report.ok).toBe(true);
    const liveSnapshotCheck = report.checks?.find((check) => check.id === "live-snapshot");
    expectRecordFields(liveSnapshotCheck, { id: "live-snapshot", status: "pass" });
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 25,
    });
  });

  it("agent contract: navigation + common act commands", async () => {
    const base = await startServerAndBase();
    const realFetch = getBrowserTestFetch();

    const nav = await postJson<{ ok: boolean; targetId?: string }>(`${base}/navigate`, {
      url: "https://example.com",
    });
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    const [navigateArgs] = pwMocks.navigateViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(navigateArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      url: "https://example.com",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });

    const click = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "click",
      ref: "1",
      button: "left",
      modifiers: ["Shift"],
    });
    expect(click.ok).toBe(true);
    const [clickArgs] = pwMocks.clickViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(clickArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      button: "left",
      modifiers: ["Shift"],
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect((clickArgs as { doubleClick?: boolean }).doubleClick).toBeUndefined();

    const clickSelector = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "button.save" }),
    });
    expect(clickSelector.status).toBe(200);
    expect(((await clickSelector.json()) as { ok?: boolean }).ok).toBe(true);
    const [clickSelectorArgs] = pwMocks.clickViaPlaywright.mock.calls[1] ?? [];
    expectRecordFields(clickSelectorArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      selector: "button.save",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect((clickSelectorArgs as { doubleClick?: boolean }).doubleClick).toBeUndefined();

    const clickCoords = await postJson<{ ok: boolean; url?: string }>(`${base}/act`, {
      kind: "clickCoords",
      x: "42.5",
      y: 64,
      doubleClick: "true",
      button: "left",
      delayMs: "10",
    });
    expect(clickCoords.ok).toBe(true);
    expect(clickCoords.url).toBe("https://example.com");
    const [clickCoordsArgs] = pwMocks.clickCoordsViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(clickCoordsArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      x: 42.5,
      y: 64,
      doubleClick: true,
      button: "left",
      delayMs: 10,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });

    const type = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "type",
      ref: "1",
      text: "",
    });
    expect(type.ok).toBe(true);
    const [typeArgs] = pwMocks.typeViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(typeArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      text: "",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect((typeArgs as { submit?: boolean }).submit).toBeUndefined();
    expect((typeArgs as { slowly?: boolean }).slowly).toBeUndefined();

    const press = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "press",
      key: "Enter",
    });
    expect(press.ok).toBe(true);
    const [pressArgs] = pwMocks.pressKeyViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(pressArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      key: "Enter",
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect((pressArgs as { delayMs?: number }).delayMs).toBeUndefined();

    const hover = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "hover",
      ref: "2",
    });
    expect(hover.ok).toBe(true);
    const [hoverArgs] = pwMocks.hoverViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(hoverArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });
    expect((hoverArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();

    const scroll = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "scrollIntoView",
      ref: "2",
    });
    expect(scroll.ok).toBe(true);
    const [scrollArgs] = pwMocks.scrollIntoViewViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(scrollArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });
    expect((scrollArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();

    const drag = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "drag",
      startRef: "3",
      endRef: "4",
    });
    expect(drag.ok).toBe(true);
    const [dragArgs] = pwMocks.dragViaPlaywright.mock.calls[0] ?? [];
    expectRecordFields(dragArgs, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      startRef: "3",
      endRef: "4",
    });
    expect((dragArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });
  it("POST /tabs/open?profile=unknown returns 404", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const result = await realFetch(`${base}/tabs/open?profile=unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("POST /tabs/open returns 400 for invalid URLs", async () => {
    setBrowserControlServerReachable(true);
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const result = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not a url" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("Invalid URL:");
  });
});

describe("profile CRUD endpoints", () => {
  beforeEach(async () => {
    await resetBrowserControlServerTestContext();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = url;
        if (u.includes("/json/list")) {
          return makeResponse([]);
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    await cleanupBrowserControlServerTestContext();
  });

  it("validates profile create/delete endpoints", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();
    const realFetch = getBrowserTestFetch();

    const createMissingName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createMissingName.status).toBe(400);
    const createMissingNameBody = (await createMissingName.json()) as { error: string };
    expect(createMissingNameBody.error).toContain("name is required");

    const createInvalidName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid Name!" }),
    });
    expect(createInvalidName.status).toBe(400);
    const createInvalidNameBody = (await createInvalidName.json()) as { error: string };
    expect(createInvalidNameBody.error).toContain("invalid profile name");

    const createDuplicate = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openclaw" }),
    });
    expect(createDuplicate.status).toBe(409);
    const createDuplicateBody = (await createDuplicate.json()) as { error: string };
    expect(createDuplicateBody.error).toContain("already exists");

    const createRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "remote", cdpUrl: "http://10.0.0.42:9222" }),
    });
    expect(createRemote.status).toBe(200);
    const createRemoteBody = (await createRemote.json()) as {
      profile?: string;
      cdpUrl?: string;
      isRemote?: boolean;
    };
    expect(createRemoteBody.profile).toBe("remote");
    expect(createRemoteBody.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(createRemoteBody.isRemote).toBe(true);

    const createBadRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "badremote", cdpUrl: "ftp://bad" }),
    });
    expect(createBadRemote.status).toBe(400);
    const createBadRemoteBody = (await createBadRemote.json()) as { error: string };
    expect(createBadRemoteBody.error).toContain("cdpUrl");

    const createClawd = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacyclawd", driver: "clawd" }),
    });
    expect(createClawd.status).toBe(200);
    const createClawdBody = (await createClawd.json()) as {
      profile?: string;
      transport?: string;
      cdpPort?: number | null;
      userDataDir?: string | null;
    };
    expect(createClawdBody.profile).toBe("legacyclawd");
    expect(createClawdBody.transport).toBe("cdp");
    expect(createClawdBody.cdpPort).toBeTypeOf("number");
    expect(createClawdBody.userDataDir).toBeNull();

    const explicitUserDataDir = "/tmp/openclaw-brave-profile";
    await fs.promises.mkdir(explicitUserDataDir, { recursive: true });
    const createExistingSession = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "brave-live",
        driver: "existing-session",
        userDataDir: explicitUserDataDir,
      }),
    });
    expect(createExistingSession.status).toBe(200);
    const createExistingSessionBody = (await createExistingSession.json()) as {
      profile?: string;
      transport?: string;
      userDataDir?: string | null;
    };
    expect(createExistingSessionBody.profile).toBe("brave-live");
    expect(createExistingSessionBody.transport).toBe("chrome-mcp");
    expect(createExistingSessionBody.userDataDir).toBe(explicitUserDataDir);

    const createBadExistingSession = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-live",
        userDataDir: explicitUserDataDir,
      }),
    });
    expect(createBadExistingSession.status).toBe(400);
    const createBadExistingSessionBody = (await createBadExistingSession.json()) as {
      error: string;
    };
    expect(createBadExistingSessionBody.error).toContain("driver=existing-session is required");

    const createLegacyDriver = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legacy", driver: "extension" }),
    });
    expect(createLegacyDriver.status).toBe(400);
    const createLegacyDriverBody = (await createLegacyDriver.json()) as { error: string };
    expect(createLegacyDriverBody.error).toContain('unsupported profile driver "extension"');

    const deleteMissing = await realFetch(`${base}/profiles/nonexistent`, {
      method: "DELETE",
    });
    expect(deleteMissing.status).toBe(404);
    const deleteMissingBody = (await deleteMissing.json()) as { error: string };
    expect(deleteMissingBody.error).toContain("not found");

    const deleteDefault = await realFetch(`${base}/profiles/openclaw`, {
      method: "DELETE",
    });
    expect(deleteDefault.status).toBe(400);
    const deleteDefaultBody = (await deleteDefault.json()) as { error: string };
    expect(deleteDefaultBody.error).toContain("cannot delete the default profile");

    const deleteInvalid = await realFetch(`${base}/profiles/Invalid-Name!`, {
      method: "DELETE",
    });
    expect(deleteInvalid.status).toBe(400);
    const deleteInvalidBody = (await deleteInvalid.json()) as { error: string };
    expect(deleteInvalidBody.error).toContain("invalid profile name");
  });
});
