// Browser tests cover agent.act hook current-tab navigation guard behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBrowserErrorResponse } from "../errors.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const chromeMcpMocks = vi.hoisted(() => ({
  evaluateChromeMcpScript: vi.fn(async () => true),
  uploadChromeMcpFile: vi.fn(async () => {}),
}));

const pathMocks = vi.hoisted(() => ({
  resolveExistingUploadPaths: vi.fn(async ({ requestedPaths }: { requestedPaths: string[] }) => ({
    ok: true,
    paths: requestedPaths,
  })),
}));

const pwMocks = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn(async () => {}),
  armFileUploadViaPlaywright: vi.fn(async () => {}),
  uploadViaPlaywright: vi.fn(async () => {}),
  clickViaPlaywright: vi.fn(async () => {}),
  setInputFilesViaPlaywright: vi.fn(async () => {}),
}));

vi.mock("../chrome-mcp.js", () => ({
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  uploadChromeMcpFile: chromeMcpMocks.uploadChromeMcpFile,
}));

vi.mock("../paths.js", () => pathMocks);

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

const { registerBrowserAgentActHookRoutes } = await import("./agent.act.hooks.js");

function createProfileContext(options?: {
  attachOnly?: boolean;
  driver?: "openclaw" | "extension";
  tabUrl?: string;
}) {
  return {
    profile: {
      attachOnly: options?.attachOnly ?? false,
      cdpIsLoopback: true,
      cdpUrl: "http://127.0.0.1:9222",
      driver: options?.driver ?? ("openclaw" as const),
      name: "default",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      title: "Internal Admin",
      url: options?.tabUrl ?? "http://127.0.0.1:8080/admin",
      type: "page",
    })),
    listTabs: vi.fn(async () => []),
  };
}

function createRouteContext(
  profileCtx: ReturnType<typeof createProfileContext>,
  options?: { allowPrivateNetwork?: boolean },
) {
  return {
    forProfile: () => profileCtx,
    mapTabError: vi.fn(toBrowserErrorResponse),
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        extraArgs: [],
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: options?.allowPrivateNetwork === true,
        },
      },
    }),
  };
}

async function callHook(params: {
  path: "/hooks/file-chooser" | "/hooks/dialog";
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
  allowPrivateNetwork?: boolean;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(
    app,
    createRouteContext(params.profileCtx, {
      allowPrivateNetwork: params.allowPrivateNetwork,
    }) as never,
  );
  const handler = postHandlers.get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: {},
      body: params.body,
    },
    response.res,
  );
  return response;
}

const blockedHookCases = [
  {
    label: "file chooser",
    path: "/hooks/file-chooser" as const,
    body: { paths: ["/tmp/upload.txt"], ref: "upload-button" },
    sideEffects: [
      pathMocks.resolveExistingUploadPaths,
      chromeMcpMocks.uploadChromeMcpFile,
      pwMocks.armFileUploadViaPlaywright,
      pwMocks.uploadViaPlaywright,
      pwMocks.clickViaPlaywright,
      pwMocks.setInputFilesViaPlaywright,
    ],
  },
  {
    label: "dialog",
    path: "/hooks/dialog" as const,
    body: { accept: true },
    sideEffects: [chromeMcpMocks.evaluateChromeMcpScript, pwMocks.armDialogViaPlaywright],
  },
];

describe("agent act hook current URL guard", () => {
  beforeEach(() => {
    for (const fn of Object.values(chromeMcpMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pathMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(pwMocks)) {
      fn.mockClear();
    }
  });

  it.each(blockedHookCases)(
    "blocks $label hooks before page side effects on a disallowed current tab",
    async ({ path, body, sideEffects }) => {
      const profileCtx = createProfileContext();

      const response = await callHook({
        path,
        body,
        profileCtx,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: "browser navigation blocked by policy",
        reason: "navigation_blocked",
      });
      expect(profileCtx.ensureTabAvailable).toHaveBeenCalledOnce();
      for (const sideEffect of sideEffects) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps file chooser path handoff local for extension-backed profiles", async () => {
    const profileCtx = createProfileContext({
      driver: "extension",
      tabUrl: "http://127.0.0.1:8080/upload",
    });

    const response = await callHook({
      path: "/hooks/file-chooser",
      body: { paths: ["/tmp/upload.txt"], ref: "upload-button" },
      profileCtx,
      allowPrivateNetwork: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(pwMocks.uploadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        browserFilesystemLocal: true,
        ref: "upload-button",
        paths: ["/tmp/upload.txt"],
      }),
    );
  });

  it("sends loopback attach-only uploads as payloads for a separate browser filesystem", async () => {
    const profileCtx = createProfileContext({
      attachOnly: true,
      tabUrl: "http://127.0.0.1:8080/upload",
    });

    const response = await callHook({
      path: "/hooks/file-chooser",
      body: { paths: ["/tmp/upload.txt"], ref: "upload-button" },
      profileCtx,
      allowPrivateNetwork: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(pwMocks.uploadViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        browserFilesystemLocal: false,
        ref: "upload-button",
        paths: ["/tmp/upload.txt"],
      }),
    );
  });
});
