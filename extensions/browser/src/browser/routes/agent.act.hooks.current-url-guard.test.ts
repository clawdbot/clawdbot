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

function createProfileContext() {
  return {
    profile: {
      cdpIsLoopback: true,
      cdpUrl: "http://127.0.0.1:9222",
      driver: "openclaw" as const,
      name: "default",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "tab-1",
      title: "Internal Admin",
      url: "http://127.0.0.1:8080/admin",
      type: "page",
    })),
    listTabs: vi.fn(async () => []),
  };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    forProfile: () => profileCtx,
    mapTabError: vi.fn(toBrowserErrorResponse),
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        extraArgs: [],
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      },
    }),
  };
}

async function callHook(params: {
  path: "/hooks/file-chooser" | "/hooks/dialog";
  body: Record<string, unknown>;
  profileCtx: ReturnType<typeof createProfileContext>;
}) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, createRouteContext(params.profileCtx) as never);
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
      expect(response.body).toEqual({ error: expect.stringMatching(/blocked|private/i) });
      expect(profileCtx.ensureTabAvailable).toHaveBeenCalledOnce();
      for (const sideEffect of sideEffects) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
    },
  );
});
