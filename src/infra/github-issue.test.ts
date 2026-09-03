import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareGithubIssue,
  prepareGithubIssueBrowserFallback,
  submitGithubIssue,
  type RunGithubCli,
} from "./github-issue.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const authArgs = ["auth", "status", "--active", "--hostname", "github.com"];
const authSuccess = cliResult({ started: true, status: 0 });

function cliResult(
  values: Partial<{
    errorCode: string;
    started: boolean;
    status: number | null;
    stdout: Buffer;
  }> = {},
) {
  return {
    started: false,
    status: null,
    stdout: Buffer.alloc(0),
    ...values,
  };
}

function prepare(body: string) {
  return prepareGithubIssue({ body, title: `Support report ${body}` });
}

describe("GitHub issue transport", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("bounds sanitized input and prepares the exact browser handoff", () => {
    const issue = prepareGithubIssue({
      body: [
        "Credential: <redacted>",
        "Account: <redacted-email>",
        "State: $OPENCLAW_STATE_DIR",
        "🦞 &=?".repeat(5_000),
      ].join("\n"),
      title: "Sanitized support failure",
    });

    expect(issue.body).toContain("Credential: <redacted>");
    expect(issue.body).toContain(`<!-- ${issue.marker} -->`);
    expect(Buffer.byteLength(issue.body, "utf8")).toBeLessThanOrEqual(20_000);
    expect(issue.fallbackUrl.length).toBeLessThanOrEqual(16_384);
    expect(new URL(issue.fallbackUrl).origin).toBe("https://github.com");
  });

  it("does not expose raw process diagnostics through a transport failure", async () => {
    const issue = prepare("private-failure");
    const rawFailure = {
      ...cliResult({ started: true, status: 4 }),
      diagnostic: "gh auth login --with-token private-value",
    };
    const runGh = vi.fn<RunGithubCli>().mockResolvedValueOnce(rawFailure);

    const result = await submitGithubIssue(issue, runGh);

    expect(result).toEqual({
      reason: "authentication-unavailable",
      status: "browser-fallback",
      url: issue.fallbackUrl,
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("keeps browser fallback truncation on a valid UTF-8 boundary", () => {
    const url = prepareGithubIssueBrowserFallback("Sanitized report", "🦞 &=?".repeat(5_000));
    const body = new URL(url).searchParams.get("body");

    expect(url.length).toBeLessThanOrEqual(16_384);
    expect(body).not.toContain("�");
    expect(body).toContain("truncated for URL");
  });

  it("submits the prepared body through stdin and accepts only the canonical issue URL", async () => {
    const issue = prepare("positive");
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from(
            "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2.0 201 Created\r\n\r\nhttps://github.com/openclaw/openclaw/issues/123\n",
          ),
        }),
      );

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(runGh).toHaveBeenNthCalledWith(1, authArgs, { input: "" });
    expect(runGh).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        "--hostname",
        "github.com",
        "--include",
        "--method",
        "POST",
        "repos/openclaw/openclaw/issues",
        "--input",
        "-",
        "--jq",
        ".html_url",
      ],
      { input: JSON.stringify({ body: issue.body, title: issue.title }) },
    );
  });

  it("uses the final HTTP response block for a definitive request rejection", async () => {
    const issue = prepare("permission-denied");
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 1,
          stdout: Buffer.from(
            "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2.0 403 Forbidden\r\n\r\n{}",
          ),
        }),
      );

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      reason: "transport-unavailable",
      status: "browser-fallback",
      url: issue.fallbackUrl,
    });
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "HTTP 408",
      result: cliResult({
        started: true,
        status: 1,
        stdout: Buffer.from("HTTP/2.0 408 Request Timeout\r\n\r\n{}"),
      }),
    },
    {
      label: "HTTP 500",
      result: cliResult({
        started: true,
        status: 1,
        stdout: Buffer.from("HTTP/2.0 500 Internal Server Error\r\n\r\n{}"),
      }),
    },
    {
      label: "network exit after dispatch",
      result: cliResult({ errorCode: "ETIMEDOUT", started: true }),
    },
    {
      label: "cancellation after dispatch",
      result: cliResult({ errorCode: "ECANCELED", started: true }),
    },
  ])("keeps $label on the no-fallback ambiguity path", async ({ label, result }) => {
    const issue = prepare(label);
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(cliResult({ started: true, status: 0, stdout: Buffer.from("[]") }));

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      reason: "creation-outcome-unknown",
      status: "outcome-unknown",
    });
    expect(runGh).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      expected: "cli-unavailable",
      label: "missing GitHub CLI",
      result: cliResult({ errorCode: "ENOENT" }),
    },
    {
      expected: "authentication-unavailable",
      label: "unauthenticated GitHub CLI",
      result: cliResult({ started: true, status: 4 }),
    },
  ])("prepares a browser fallback for $label without starting issue creation", async (test) => {
    const issue = prepare(test.label);
    const runGh = vi.fn<RunGithubCli>().mockResolvedValueOnce(test.result);

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      reason: test.expected,
      status: "browser-fallback",
      url: issue.fallbackUrl,
    });
    expect(runGh).toHaveBeenCalledOnce();
  });

  it("reconciles an uncertain create result by exact marker, title, and body", async () => {
    const issue = prepare("reconcile");
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(cliResult({ started: true, status: 1 }))
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from(
            JSON.stringify([
              {
                body: issue.body,
                title: issue.title,
                url: "https://github.com/openclaw/openclaw/issues/456",
              },
            ]),
          ),
        }),
      );

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/456",
    });
    expect(runGh.mock.calls[2]?.[0]).toContain(`"${issue.marker}" in:body`);
  });

  it.each([
    "javascript:alert(1)",
    "https://github.com.evil.example/openclaw/openclaw/issues/123",
    "https://github.com/openclaw/openclaw/issues/123?token=secret",
  ])("does not expose or fall back after malformed created URL %s", async (url) => {
    const issue = prepare(url);
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from(`HTTP/2.0 201 Created\r\n\r\n${url}\n`),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from(JSON.stringify([{ body: issue.body, title: issue.title, url }])),
        }),
      );

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      reason: "creation-outcome-unknown",
      status: "outcome-unknown",
    });
  });

  it("does not reconcile a marker search candidate with different content", async () => {
    const issue = prepare("marker-collision-negative");
    const runGh = vi
      .fn<RunGithubCli>()
      .mockResolvedValueOnce(authSuccess)
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from("HTTP/2.0 201 Created\r\n\r\nnot-a-url\n"),
        }),
      )
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from(
            JSON.stringify([
              {
                body: `${issue.body}\nchanged`,
                title: issue.title,
                url: "https://github.com/openclaw/openclaw/issues/999",
              },
            ]),
          ),
        }),
      );

    await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
      reason: "creation-outcome-unknown",
      status: "outcome-unknown",
    });
  });

  it("deduplicates concurrent submissions with the same marker", async () => {
    const issue = prepare("concurrent");
    let releaseAuth: ((value: ReturnType<typeof cliResult>) => void) | undefined;
    const auth = new Promise<ReturnType<typeof cliResult>>((resolve) => {
      releaseAuth = resolve;
    });
    const runGh = vi
      .fn<RunGithubCli>()
      .mockReturnValueOnce(auth)
      .mockResolvedValueOnce(
        cliResult({
          started: true,
          status: 0,
          stdout: Buffer.from("https://github.com/openclaw/openclaw/issues/789\n"),
        }),
      );

    const first = submitGithubIssue(issue, runGh);
    const second = submitGithubIssue(issue, runGh);
    expect(first).toBe(second);
    expect(runGh).toHaveBeenCalledOnce();
    releaseAuth?.(authSuccess);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "created", url: "https://github.com/openclaw/openclaw/issues/789" },
      { status: "created", url: "https://github.com/openclaw/openclaw/issues/789" },
    ]);
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled authentication preflight without exposing process diagnostics", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdin = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(() => queueMicrotask(() => child.emit("spawn"))),
    });
    child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.kill = vi.fn(() => false);
    child.unref = vi.fn();
    spawnMock.mockReturnValue(child);
    const issue = prepare("timeout");

    const submission = submitGithubIssue(issue);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(submission).resolves.toEqual({
      reason: "authentication-unavailable",
      status: "browser-fallback",
      url: issue.fallbackUrl,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
  });
});
