import { describe, expect, it } from "vitest";
import { classifyControlUiRequest } from "./control-ui-routing.js";

describe("classifyControlUiRequest", () => {
  describe("root-mounted control ui", () => {
    it.each([
      {
        name: "serves the root entrypoint",
        pathname: "/",
        method: "GET",
        expected: { kind: "serve" as const },
      },
      {
        name: "serves other read-only SPA routes",
        pathname: "/chat",
        method: "HEAD",
        expected: { kind: "serve" as const },
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
        name: "keeps API routes outside the SPA catch-all",
        pathname: "/api/sessions",
        method: "GET",
        expected: { kind: "not-control-ui" as const },
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
        expected: { kind: "serve" as const },
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
