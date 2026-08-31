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
  it.each([
    {
      name: "missing Accept header",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: undefined,
      expected: true,
    },
    {
      name: "empty Accept header",
      basePath: "/openclaw",
      pathname: "/openclaw/chat",
      method: "HEAD",
      accept: "  ",
      expected: true,
    },
    {
      name: "browser Accept header",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html, application/xhtml+xml;q=0.9, application/xml;q=0.8",
      expected: true,
    },
    {
      name: "text wildcard at root",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/*",
      expected: true,
    },
    {
      name: "nonzero text wildcard under a base path",
      basePath: "/openclaw",
      pathname: "/openclaw/chat",
      method: "HEAD",
      accept: "application/json, text/*;q=0.5",
      expected: true,
    },
    {
      name: "zero-quality text wildcard rejection",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/*;q=0",
      expected: false,
    },
    {
      name: "zero-quality HTML rejection",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html;q=0",
      expected: false,
    },
    {
      name: "rejected HTML entry with an accepting wildcard",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html;q=0, */*",
      expected: true,
    },
    {
      name: "nonzero HTML quality",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html;q=0.5",
      expected: true,
    },
    {
      name: "mixed-case zero-quality parameter",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html; Q = 0",
      expected: false,
    },
    {
      name: "trailing-dot zero quality",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html; q=0.",
      expected: false,
    },
    {
      name: "one-decimal zero quality",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "text/html;q=0.0",
      expected: false,
    },
    {
      name: "mixed-case XHTML three-decimal rejection",
      basePath: "/openclaw",
      pathname: "/openclaw/chat",
      method: "HEAD",
      accept: "application/json, Application/XHTML+XML ; q=0.000",
      expected: false,
    },
    {
      name: "zero-quality wildcard rejection",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "application/json, */*;q=0",
      expected: false,
    },
    {
      name: "JSON-only Accept header",
      basePath: "",
      pathname: "/chat",
      method: "GET",
      accept: "application/json",
      expected: false,
    },
    {
      name: "event-stream Accept header under a base path",
      basePath: "/openclaw",
      pathname: "/openclaw/chat",
      method: "HEAD",
      accept: "text/event-stream",
      expected: false,
    },
    {
      name: "plugin manager recovery at root",
      basePath: "",
      pathname: "/settings/plugins",
      method: "GET",
      accept: "application/json",
      expected: true,
    },
    {
      name: "plugin manager recovery under a base path",
      basePath: "/openclaw",
      pathname: "/openclaw/settings/plugins/",
      method: "HEAD",
      accept: "text/event-stream",
      expected: true,
    },
  ])("classifies $name", ({ basePath, pathname, method, accept, expected }) => {
    expect(classifyControlUiRequest({ basePath, pathname, search: "", method, accept })).toEqual({
      kind: "serve",
      spaFallback: expected,
    });
  });
});

describe("classifyControlUiRequest", () => {
  describe("root-mounted control ui", () => {
    it.each([
      {
        name: "serves the root entrypoint",
        pathname: "/",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "serves other read-only SPA routes",
        pathname: "/chat",
        method: "HEAD",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "serves the plugin manager without claiming plugin HTTP routes",
        pathname: "/settings/plugins",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "keeps health probes outside the SPA catch-all",
        pathname: "/healthz",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps readiness probes outside the SPA catch-all",
        pathname: "/ready",
        method: "HEAD",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps plugin routes outside the SPA catch-all",
        pathname: "/plugins/webhook",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the plugin HTTP root outside the SPA catch-all",
        pathname: "/plugins",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps API routes outside the SPA catch-all",
        pathname: "/api/sessions",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the device join root outside the SPA catch-all",
        pathname: "/j",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps device join codes outside the SPA catch-all",
        pathname: `/j/${"a".repeat(22)}`,
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the OpenAI-compatible API root outside the SPA catch-all",
        pathname: "/v1",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the OpenAI-compatible API root slash outside the SPA catch-all",
        pathname: "/v1/",
        method: "HEAD",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps OpenAI-compatible model discovery outside the SPA catch-all",
        pathname: "/v1/models",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps OpenAI-compatible model details outside the SPA catch-all",
        pathname: "/v1/models/openclaw",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps OpenAI-compatible responses outside the SPA catch-all",
        pathname: "/v1/responses",
        method: "HEAD",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the standalone MCP App shell outside the SPA catch-all",
        pathname: "/__openclaw__/mcp-app",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps the standalone MCP App view outside the SPA catch-all",
        pathname: "/__openclaw__/mcp-app/view",
        method: "HEAD",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "preserves SPA routes that only resemble the standalone MCP App namespace",
        pathname: "/__openclaw__/mcp-apps",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "keeps MCP App descendants outside the SPA catch-all",
        pathname: "/__openclaw__/mcp-app/other",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps worker admission outside the SPA catch-all",
        pathname: "/__openclaw__/worker",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps worker admission descendants outside the SPA catch-all",
        pathname: "/__openclaw__/worker/other",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "preserves SPA routes that only resemble worker admission",
        pathname: "/__openclaw__/workers",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "keeps node workspace transfers outside the SPA catch-all",
        pathname: "/__openclaw__/worker-transfer/v1/environments/worker%3A1/blobs/abc",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps malformed node workspace transfer descendants outside the SPA catch-all",
        pathname: "/__openclaw__/worker-transfer/other",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "preserves SPA routes that only resemble node workspace transfers",
        pathname: "/__openclaw__/worker-transfers",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "keeps health probe descendants outside the SPA catch-all",
        pathname: "/healthz/details",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "keeps readiness probe trailing slashes outside the SPA catch-all",
        pathname: "/readyz/",
        method: "HEAD",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "preserves SPA routes that only resemble probe paths",
        pathname: "/healthcheck",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "preserves the SPA root that only resembles the OpenAI-compatible API",
        pathname: "/v12",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "preserves SPA routes that only resemble the OpenAI-compatible API",
        pathname: "/v12/models",
        method: "GET",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "returns not-found for legacy ui routes",
        pathname: "/ui/settings",
        method: "GET",
        expected: { kind: "not-found" as const },
      },
      {
        name: "falls through non-read requests",
        pathname: "/imessage-webhook",
        method: "POST",
        expected: { kind: "not-control-ui" as const },
      },
    ])("$name", ({ pathname, method, expected }) => {
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
    it.each([
      {
        name: "redirects the basePath entrypoint",
        pathname: "/openclaw",
        search: "?foo=1",
        method: "GET",
        expected: { kind: "redirect" as const, location: "/openclaw/?foo=1" },
      },
      {
        name: "serves nested read-only routes",
        pathname: "/openclaw/chat",
        search: "",
        method: "HEAD",
        expected: { kind: "serve" as const, spaFallback: true },
      },
      {
        name: "falls through unmatched paths",
        pathname: "/elsewhere/chat",
        search: "",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
      },
      {
        name: "falls through write requests to the basePath entrypoint",
        pathname: "/openclaw",
        search: "",
        method: "POST",
        expected: { kind: "not-control-ui" as const },
      },
      ...["PUT", "DELETE", "PATCH", "OPTIONS"].map((method) => ({
        name: `falls through ${method} subroute requests`,
        pathname: "/openclaw/webhook",
        search: "",
        method,
        expected: { kind: "not-control-ui" as const },
      })),
    ])("$name", ({ pathname, search, method, expected }) => {
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
