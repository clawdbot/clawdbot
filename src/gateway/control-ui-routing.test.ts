/**
 * Control UI gateway routing tests.
 */
import { describe, expect, it } from "vitest";
import {
  classifyControlUiRequest,
  isControlUiApprovalDocumentPath,
  isControlUiFocusDocumentPath,
  isControlUiPluginManagerRequest,
} from "./control-ui-routing.js";

describe("isControlUiPluginManagerRequest", () => {
  it.each([
    { basePath: "", pathname: "/settings/plugins", method: "GET", expected: true },
    { basePath: "", pathname: "/settings/plugins/", method: "HEAD", expected: true },
    {
      basePath: "/openclaw",
      pathname: "/openclaw/settings/plugins",
      method: "GET",
      expected: true,
    },
    { basePath: "", pathname: "/settings/plugins", method: "POST", expected: false },
    { basePath: "", pathname: "/plugins", method: "GET", expected: false },
  ])("classifies $method $pathname", ({ basePath, pathname, method, expected }) => {
    expect(isControlUiPluginManagerRequest({ basePath, pathname, method })).toBe(expected);
  });
});

describe("isControlUiApprovalDocumentPath", () => {
  it.each([
    { basePath: "", pathname: "/approve" },
    { basePath: "", pathname: "/approve/" },
    { basePath: "", pathname: "/approve/plugin%3Arequest.json" },
    { basePath: "/openclaw", pathname: "/openclaw/approve/exec%3Aa%2Fb" },
  ])("reserves $pathname", ({ basePath, pathname }) => {
    expect(isControlUiApprovalDocumentPath({ basePath, pathname })).toBe(true);
  });

  it.each([
    { basePath: "", pathname: "/approvals/id" },
    { basePath: "", pathname: "/approve/id/extra" },
    { basePath: "/openclaw", pathname: "/approve/id" },
  ])("does not reserve $pathname", ({ basePath, pathname }) => {
    expect(isControlUiApprovalDocumentPath({ basePath, pathname })).toBe(false);
  });
});

describe("isControlUiFocusDocumentPath", () => {
  it.each([
    { basePath: "", pathname: "/focus" },
    { basePath: "", pathname: "/focus/" },
    { basePath: "", pathname: "/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb" },
    { basePath: "", pathname: "/focus/not-supported" },
    { basePath: "/openclaw", pathname: "/openclaw/focus/desktop/control" },
  ])("classifies $pathname", ({ basePath, pathname }) => {
    expect(isControlUiFocusDocumentPath({ basePath, pathname })).toBe(true);
  });

  it.each([
    { basePath: "", pathname: "/focused" },
    { basePath: "", pathname: "/focused/terminal" },
    { basePath: "/openclaw", pathname: "/focus/terminal" },
    { basePath: "/openclaw", pathname: "/openclaw/focused" },
  ])("does not classify $pathname", ({ basePath, pathname }) => {
    expect(isControlUiFocusDocumentPath({ basePath, pathname })).toBe(false);
  });
});

describe("Control UI SPA fallback Accept routing", () => {
  it.each<[string, string, string, string, string | undefined, boolean]>([
    ["missing Accept header", "", "/chat", "GET", undefined, true],
    ["empty Accept header", "/openclaw", "/openclaw/chat", "HEAD", "  ", true],
    [
      "browser Accept header",
      "",
      "/chat",
      "GET",
      "text/html, application/xhtml+xml;q=0.9, application/xml;q=0.8",
      true,
    ],
    ["text wildcard at root", "", "/chat", "GET", "text/*", true],
    [
      "nonzero text wildcard under a base path",
      "/openclaw",
      "/openclaw/chat",
      "HEAD",
      "application/json, text/*;q=0.5",
      true,
    ],
    ["zero-quality text wildcard rejection", "", "/chat", "GET", "text/*;q=0", false],
    ["zero-quality HTML rejection", "", "/chat", "GET", "text/html;q=0", false],
    [
      "specific HTML rejection overrides an accepting wildcard",
      "",
      "/chat",
      "GET",
      "text/html;q=0, */*",
      false,
    ],
    ...[
      { accept: "text/html;q=0, text/*;charset=utf-8", expected: false },
      { accept: "text/html;charset=utf-8;q=0, text/html;q=1", expected: false },
      { accept: "text/html;q=0;charset=utf-8, */*", expected: false },
      { accept: "text/html;q=1;charset=utf-16, */*;q=0", expected: false },
      { accept: "text/html;profile=other;q=0, */*", expected: true },
      { accept: 'text/html;note="a,b;c", */*', expected: true },
      { accept: "application/xhtml+xml", expected: true },
    ].map(({ accept, expected }): [string, string, string, string, string, boolean] => [
      `representation precedence: ${accept}`,
      "/openclaw",
      "/openclaw/chat",
      "HEAD",
      accept,
      expected,
    ]),
    ["nonzero HTML quality", "", "/chat", "GET", "text/html;q=0.5", true],
    ["mixed-case zero-quality parameter", "", "/chat", "GET", "text/html; Q = 0", false],
    ["trailing-dot zero quality", "", "/chat", "GET", "text/html; q=0.", false],
    ["one-decimal zero quality", "", "/chat", "GET", "text/html;q=0.0", false],
    [
      "mixed-case XHTML three-decimal rejection",
      "/openclaw",
      "/openclaw/chat",
      "HEAD",
      "application/json, Application/XHTML+XML ; q=0.000",
      false,
    ],
    ["zero-quality wildcard rejection", "", "/chat", "GET", "application/json, */*;q=0", false],
    ["JSON-only Accept header", "", "/chat", "GET", "application/json", false],
    [
      "event-stream Accept header under a base path",
      "/openclaw",
      "/openclaw/chat",
      "HEAD",
      "text/event-stream",
      false,
    ],
    ["plugin manager recovery at root", "", "/settings/plugins", "GET", "application/json", true],
    [
      "plugin manager recovery under a base path",
      "/openclaw",
      "/openclaw/settings/plugins/",
      "HEAD",
      "text/event-stream",
      true,
    ],
  ])("classifies %s", (_name, basePath, pathname, method, accept, expected) => {
    expect(classifyControlUiRequest({ basePath, pathname, search: "", method, accept })).toEqual({
      kind: "serve",
      spaFallback: expected,
    });
  });
});

describe("classifyControlUiRequest", () => {
  describe("root-mounted control ui", () => {
    it.each([
      ["serves the root entrypoint", "/", "GET", { kind: "serve" as const, spaFallback: true }],
      [
        "serves other read-only SPA routes",
        "/chat",
        "HEAD",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "serves the plugin manager without claiming plugin HTTP routes",
        "/settings/plugins",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "keeps health probes outside the SPA catch-all",
        "/healthz",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps readiness probes outside the SPA catch-all",
        "/ready",
        "HEAD",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps plugin routes outside the SPA catch-all",
        "/plugins/webhook",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the plugin HTTP root outside the SPA catch-all",
        "/plugins",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps API routes outside the SPA catch-all",
        "/api/sessions",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the device join root outside the SPA catch-all",
        "/j",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps device join codes outside the SPA catch-all",
        `/j/${"a".repeat(22)}`,
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the OpenAI-compatible API root outside the SPA catch-all",
        "/v1",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the OpenAI-compatible API root slash outside the SPA catch-all",
        "/v1/",
        "HEAD",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps OpenAI-compatible model discovery outside the SPA catch-all",
        "/v1/models",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps OpenAI-compatible model details outside the SPA catch-all",
        "/v1/models/openclaw",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps OpenAI-compatible responses outside the SPA catch-all",
        "/v1/responses",
        "HEAD",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the standalone MCP App shell outside the SPA catch-all",
        "/__openclaw__/mcp-app",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps the standalone MCP App view outside the SPA catch-all",
        "/__openclaw__/mcp-app/view",
        "HEAD",
        { kind: "not-control-ui" as const },
      ],
      [
        "preserves SPA routes that only resemble the standalone MCP App namespace",
        "/__openclaw__/mcp-apps",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "keeps MCP App descendants outside the SPA catch-all",
        "/__openclaw__/mcp-app/other",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps worker admission outside the SPA catch-all",
        "/__openclaw__/worker",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps worker admission descendants outside the SPA catch-all",
        "/__openclaw__/worker/other",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "preserves SPA routes that only resemble worker admission",
        "/__openclaw__/workers",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "keeps node workspace transfers outside the SPA catch-all",
        "/__openclaw__/worker-transfer/v1/environments/worker%3A1/blobs/abc",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps malformed node workspace transfer descendants outside the SPA catch-all",
        "/__openclaw__/worker-transfer/other",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "preserves SPA routes that only resemble node workspace transfers",
        "/__openclaw__/worker-transfers",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "keeps health probe descendants outside the SPA catch-all",
        "/healthz/details",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "keeps readiness probe trailing slashes outside the SPA catch-all",
        "/readyz/",
        "HEAD",
        { kind: "not-control-ui" as const },
      ],
      [
        "preserves SPA routes that only resemble probe paths",
        "/healthcheck",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "preserves the SPA root that only resembles the OpenAI-compatible API",
        "/v12",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "preserves SPA routes that only resemble the OpenAI-compatible API",
        "/v12/models",
        "GET",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "returns not-found for legacy ui routes",
        "/ui/settings",
        "GET",
        { kind: "not-found" as const },
      ],
      [
        "falls through non-read requests",
        "/imessage-webhook",
        "POST",
        { kind: "not-control-ui" as const },
      ],
    ])("%s", (_name, pathname, method, expected) => {
      expect(
        classifyControlUiRequest({
          basePath: "",
          pathname,
          search: "",
          method,
        }),
      ).toEqual(expected);
    });
  });

  describe("basePath-mounted control ui", () => {
    it.each<[string, string, string, string, ReturnType<typeof classifyControlUiRequest>]>([
      [
        "redirects the basePath entrypoint",
        "/openclaw",
        "?foo=1",
        "GET",
        { kind: "redirect" as const, location: "/openclaw/?foo=1" },
      ],
      [
        "serves nested read-only routes",
        "/openclaw/chat",
        "",
        "HEAD",
        { kind: "serve" as const, spaFallback: true },
      ],
      [
        "falls through unmatched paths",
        "/elsewhere/chat",
        "",
        "GET",
        { kind: "not-control-ui" as const },
      ],
      [
        "falls through write requests to the basePath entrypoint",
        "/openclaw",
        "",
        "POST",
        { kind: "not-control-ui" as const },
      ],
      ...["PUT", "DELETE", "PATCH", "OPTIONS"].map(
        (method): [string, string, string, string, ReturnType<typeof classifyControlUiRequest>] => [
          `falls through ${method} subroute requests`,
          "/openclaw/webhook",
          "",
          method,
          { kind: "not-control-ui" },
        ],
      ),
    ])("%s", (_name, pathname, search, method, expected) => {
      expect(
        classifyControlUiRequest({
          basePath: "/openclaw",
          pathname,
          search,
          method,
        }),
      ).toEqual(expected);
    });
  });
});
