import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  ControlUiGitHubError,
  fetchGitHubApi,
  formatControlUiGitHubPreviewError,
  readGitHubJsonResponse,
} from "./control-ui-github-api.js";

describe("Control UI GitHub failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<{ status: number; headers: Record<string, string>; delay: number }>([
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788393720" },
      delay: 120_000,
    },
    { status: 429, headers: { "retry-after": "90" }, delay: 90_000 },
    {
      status: 403,
      headers: {
        "retry-after": "Thu, 03 Sep 2026 00:02:00 GMT",
        "x-ratelimit-reset": "1788393900",
      },
      delay: 120_000,
    },
  ])(
    "preserves rate-limit status and retry timing for HTTP $status",
    async ({ status, headers, delay }) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-03T00:00:00Z"));
      const error = await readGitHubJsonResponse(
        new Response('{"message":"secret-upstream-body"}', { status, headers }),
      ).catch((failure: unknown) => failure);

      expect(error).toMatchObject({ statusCode: 429, retryAfterMs: delay });
      const display = formatControlUiGitHubPreviewError(error);
      expect(display).toMatchObject({ retryable: true, retryAfterMs: delay });
      expect(display.message).toContain(`HTTP ${status}`);
      expect(display.message).toMatch(/rate limit/i);
      expect(display.message).not.toContain("secret-upstream-body");
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-03T00:00:30Z"));
      expect(formatControlUiGitHubPreviewError(error).retryAfterMs).toBe(delay - 30_000);
    },
  );

  it.each([
    { status: 401, reason: /authentication/i, action: /Settings/ },
    { status: 403, reason: /access denied/i, action: /repository access/i },
    { status: 404, reason: /unavailable or not public/i, action: /open the link/i },
    { status: 500, reason: /HTTP 500/, action: /retry/i },
  ])(
    "explains HTTP $status without exposing the response body",
    async ({ status, reason, action }) => {
      const error = await readGitHubJsonResponse(
        new Response('{"message":"secret-upstream-body"}', { status }),
      ).catch((failure: unknown) => failure);
      const display = formatControlUiGitHubPreviewError(error);

      expect(display.message).toMatch(reason);
      expect(display.message).toMatch(action);
      expect(display.message).not.toContain("secret-upstream-body");
      expect(display.retryable).toBe(status === 500);
    },
  );

  it("does not distinguish private repositories from missing items", async () => {
    const missing = await readGitHubJsonResponse(new Response(null, { status: 404 })).catch(
      (failure: unknown) => failure,
    );
    expect(
      formatControlUiGitHubPreviewError(
        new ControlUiGitHubError(404, "GitHub repository is not public"),
      ),
    ).toEqual(formatControlUiGitHubPreviewError(missing));
  });

  it("ignores malformed rate-limit timing", async () => {
    const error = await readGitHubJsonResponse(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "secret-upstream-header", "x-ratelimit-reset": "Infinity" },
      }),
    ).catch((failure: unknown) => failure);
    const display = formatControlUiGitHubPreviewError(error);

    expect(display.retryAfterMs).toBeUndefined();
    expect(display.message).toMatch(/rate limit/i);
    expect(display.message).not.toContain("secret-upstream-header");
  });

  it.each([
    { failure: new DOMException("secret-abort-reason", "TimeoutError"), reason: /timed out/i },
    { failure: new TypeError("fetch failed: secret-network-address"), reason: /reach GitHub/i },
  ])("explains transport errors without leaking their diagnostics", async ({ failure, reason }) => {
    const error = await fetchGitHubApi(
      "https://api.github.com/repos/openclaw/openclaw",
      vi.fn<typeof fetch>().mockRejectedValue(failure),
    ).catch((caught: unknown) => caught);
    const display = formatControlUiGitHubPreviewError(error);

    expect(display.message).toMatch(reason);
    expect(display.message).toMatch(/retry/i);
    expect(display.message).not.toContain("secret-");
    expect(display.retryable).toBe(true);
  });

  it("dispatches an admitted request before its caller can retire", async () => {
    let active = true;
    let activeAtDispatch: boolean | undefined;
    const pending = fetchGitHubApi(
      "https://api.github.com/repos/owner/repo/actions/runs",
      async () => {
        activeAtDispatch = active;
        return new Response("{}");
      },
      "synthetic-token",
    );
    active = false;
    await pending;

    expect(activeAtDispatch).toBe(true);
  });

  it("shows configured credential recovery instructions but hides unknown errors", () => {
    const unavailable = new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: "control-ui-github",
      state: "unavailable",
      paths: ["gateway.controlUi.github.token"],
      refKeys: [],
      reason: "secret-store-diagnostic",
    });
    expect(formatControlUiGitHubPreviewError(unavailable)).toEqual({
      message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
      retryable: false,
    });
    const display = formatControlUiGitHubPreviewError(
      new Error("Authorization: Bearer secret-unknown-credential"),
    );
    expect(display.message).toMatch(/retry|logs/i);
    expect(display.message).not.toContain("secret-unknown-credential");
  });
});
