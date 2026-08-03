// PR Context And Evidence Policy tests cover GitHub PR-body policy behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  NEEDS_PR_CONTEXT_LABEL,
  PROOF_OVERRIDE_LABEL,
  evaluateClawSweeperExactHeadProof,
  evaluatePullRequestContext,
  hasClawSweeperExactHeadProof,
  isMaintainerTeamMember,
  labelsForPullRequestContext,
  readBoundedGitHubApiJson,
} from "../../scripts/github/real-behavior-proof-policy.mjs";

const blankTemplateBody = readFileSync(
  new URL("../../.github/pull_request_template.md", import.meta.url),
  "utf8",
);

function externalPr(body: string, overrides: Record<string, unknown> = {}) {
  return {
    body,
    author_association: "CONTRIBUTOR",
    user: {
      login: "external-contributor",
      type: "User",
    },
    labels: [],
    ...overrides,
  };
}

function proofBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    problem: "The gateway dropped the configured Discord channel during startup.",
    evidence,
    ...overrides,
  };
  return [
    "## What Problem This Solves",
    "",
    fields.problem,
    "",
    "## Evidence",
    "",
    fields.evidence,
  ].join("\n");
}

function stalledResponse() {
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  const reader = {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>(() => {
        keepAlive = setTimeout(() => {}, 10_000);
      }),
    cancel: vi.fn(() => {
      if (keepAlive) {
        clearTimeout(keepAlive);
      }
      return Promise.resolve();
    }),
    releaseLock: vi.fn(),
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => reader,
    },
  };
}

function contentLengthResponse(contentLength: number) {
  const cancel = vi.fn(() => Promise.resolve());
  return {
    headers: new Headers({ "content-length": String(contentLength) }),
    body: { cancel },
    cancel,
  };
}

function chunkedResponse(chunks: Uint8Array[]) {
  const cancel = vi.fn(() => Promise.resolve());
  const read = vi.fn();
  for (const chunk of chunks) {
    read.mockResolvedValueOnce({ done: false, value: chunk });
  }
  read.mockResolvedValueOnce({ done: true, value: undefined });
  return {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read,
        cancel,
        releaseLock: vi.fn(),
      }),
    },
  };
}

describe("real-behavior-proof-policy", () => {
  it.each([
    "![after](https://github.com/user-attachments/assets/abc123)",
    "Linked artifact: https://github.com/openclaw/openclaw/actions/runs/123456789/artifacts/987654321",
    "Redacted runtime log: gateway connected Discord channel and delivered the reply.",
    ["Terminal transcript:", "```text", "$ openclaw gateway status", "discord ready", "```"].join(
      "\n",
    ),
  ])("passes external PRs with evidence: %s", (evidence) => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody(evidence)),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("passes CRLF-formatted external PRs with screenshot proof", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          /\n/g,
          "\r\n",
        ),
      ),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("requires authored problem content instead of template comments", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          "The gateway dropped the configured Discord channel during startup.",
          "<!-- Describe the concrete user, product, or operational problem. -->",
        ),
      ),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves"]);
  });

  it("does not accept the untouched current template", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(blankTemplateBody),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("does not accept sections hidden by an unclosed HTML comment", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(`<!--\n${proofBody("pnpm test passed.")}`),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts literal HTML comments inside fenced evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody(["```html", "<!-- captured fragment", "<p>ready</p>", "```"].join("\n")),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("accepts nested Markdown headings inside Evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        proofBody(["### Focused tests", "", "`pnpm test` passed."].join("\n")),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("rejects None as evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("None")),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["Evidence"]);
  });

  it("rejects Markdown separators as context and evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("---", { problem: "***" })),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("does not accept legacy fields hidden by HTML comments", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        [
          "## Real behavior proof",
          "",
          "<!--",
          "Behavior addressed: The gateway dropped the configured Discord channel during startup.",
          "Evidence after fix: pnpm test passed.",
          "-->",
        ].join("\n"),
      ),
    });

    expect(evaluation.status).toBe("missing");
    expect(evaluation.missingSections).toEqual(["What Problem This Solves", "Evidence"]);
  });

  it("accepts legacy behavior fields while open PRs still use the old template", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(
        [
          "## Real behavior proof",
          "",
          "- Behavior addressed: The gateway dropped the configured Discord channel during startup.",
          "- Real environment tested: macOS 15.4, Node 24, local OpenClaw gateway.",
          "- Exact steps or command run after this patch: pnpm openclaw gateway restart",
          "- Evidence after fix: ![after](https://github.com/user-attachments/assets/gateway-ready)",
          "- Observed result after fix: The gateway stayed connected and Discord reported ready.",
          "- What was not tested: No known gaps.",
        ].join("\n"),
      ),
    });

    expect(evaluation.status).toBe("passed");
  });

  it("accepts Markdown headings copied inside fenced evidence", () => {
    const body = proofBody(
      [
        "Terminal transcript:",
        "```text",
        "compiled system prompt:",
        "```js",
        "console.log('not a closing fence')",
        "## Real behavior proof",
        "Behavior addressed: copied prompt content, not a PR proof section.",
        "## TOOLS.md",
        "Observed result: ```",
        "Observed result: not tested",
        "What was not tested: copied template text",
        "not tested",
        "openclaw gateway status",
        "discord ready",
        "```",
      ].join("\n"),
    );
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(body),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("uses the latest Evidence section when duplicates exist", () => {
    const validProof = proofBody(
      [
        "Terminal transcript:",
        "```text",
        "$ openclaw doctor --non-interactive",
        "Discord external plugin is installed without explicit trust.",
        "Add plugins.entries.discord.enabled=true to trust it.",
        "```",
      ].join("\n"),
    );
    const testEvidence = proofBody("Focused tests passed: 2 files, 36 tests.");

    const laterValid = evaluatePullRequestContext({
      pullRequest: externalPr(
        [testEvidence, "## Summary", "- Keep the detailed proof below.", validProof].join("\n\n"),
      ),
    });
    const laterInvalid = evaluatePullRequestContext({
      pullRequest: externalPr(
        [validProof, "## Evidence", "<!-- Add the most useful validation evidence. -->"].join(
          "\n\n",
        ),
      ),
    });

    expect(laterValid.status).toBe("passed");
    expect(labelsForPullRequestContext(laterValid)).toEqual([]);
    expect(laterInvalid.status).toBe("missing");
    expect(laterInvalid.missingSections).toEqual(["Evidence"]);
  });

  it("accepts out-of-scope follow-ups as not-tested proof detail", () => {
    const body = [
      "## What Problem This Solves",
      "",
      "Cron validation should retain the configured low thinking level.",
      "",
      "## Evidence",
      "",
      "- Real environment tested: Local macOS source checkout, Node 24.",
      "- Exact steps or command run after this patch:",
      "  1. Built the local checkout with `node scripts/build-all.mjs`.",
      "  2. Ran a redacted behavior probe for `provider=google`, `model=gemini-3-flash-preview`, and `catalogReasoning=false`.",
      '- Evidence after fix: `.artifacts/behavior-85156/after-installed.json` recorded `lowSupported: true` and `fallbackFromLow: "low"`.',
      "- Observed result after fix:",
      "  - `levels: off, minimal, low, medium, adaptive, high`",
      "  - `lowSupported: true`",
      "  - `fallbackFromLow: low`",
      "  - `local command version: OpenClaw 2026.5.21`",
      "",
      "## Out-of-scope Follow-ups",
      "- No live systemd cron schedule was tested.",
      "- No real Google provider request was sent.",
    ].join("\n");
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(body),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("accepts source PR proof when explicit gaps live in out-of-scope follow-ups", () => {
    const body = [
      "## What Problem This Solves",
      "",
      "Cron validation downgraded Google Gemini 3 low thinking to off.",
      "",
      "## Evidence",
      "",
      "- Real environment tested: Local macOS source checkout, Node v24.8.0, OpenClaw 2026.5.21 (c8a35c4), local `openclaw` shim pointed at the freshly built checkout. No channel credentials or provider API keys were used.",
      "- Exact steps or command run after this patch:",
      "  1. Built the local checkout with `node scripts/build-all.mjs`.",
      "  2. Updated `/Users/example/.local/bin/openclaw` to run this checkout's `openclaw.mjs` and verified `/Users/example/.local/bin/openclaw --version`.",
      "  3. Ran a redacted behavior probe for the reported cron validation decision with `provider=google`, `model=gemini-3-flash-preview`, `configuredThinkingDefault=low`, and `catalogReasoning=false`.",
      '- Evidence after fix: `.artifacts/behavior-85156/after-installed.json` from the local checkout recorded `lowSupported: true` and `fallbackFromLow: "low"`.',
      "- Observed result after fix:",
      "  - `levels: off, minimal, low, medium, adaptive, high`",
      "  - `lowSupported: true`",
      "  - `fallbackFromLow: low`",
      "  - `local command version: OpenClaw 2026.5.21 (c8a35c4)`",
      "",
      "## Out-of-scope Follow-ups",
      "- No live systemd cron schedule is added in this PR.",
      "- No real Google provider request is sent in this PR.",
      "- No catalog refresh or provider model-list behavior is changed in this PR.",
      "- No channel, gateway allowlist, credential, or auth-profile behavior is changed in this PR.",
    ].join("\n");
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(body),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("fails external PRs without required context and evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr("## Summary\n\n- Fixed startup."),
    });

    expect(evaluation.status).toBe("missing");
    expect(labelsForPullRequestContext(evaluation)).toEqual([NEEDS_PR_CONTEXT_LABEL]);
  });

  it("fails external PRs that say the changed behavior was not tested", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("not tested")),
    });

    expect(evaluation.status).toBe("missing");
    expect(labelsForPullRequestContext(evaluation)).toEqual([NEEDS_PR_CONTEXT_LABEL]);
  });

  it("accepts focused test and CI evidence", () => {
    const evaluation = evaluatePullRequestContext({
      pullRequest: externalPr(proofBody("pnpm test passed and CI is green.")),
    });

    expect(evaluation.status).toBe("passed");
    expect(labelsForPullRequestContext(evaluation)).toEqual([]);
  });

  it("skips maintainer and bot PRs but requires context from external PRs", () => {
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", { author_association: "MEMBER" }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        }),
      }).status,
    ).toBe("skipped");
    expect(
      evaluatePullRequestContext({
        pullRequest: externalPr("", { labels: [{ name: PROOF_OVERRIDE_LABEL }] }),
      }).status,
    ).toBe("missing");
  });

  it("accepts ClawSweeper pass verdict comments only for the exact PR head", () => {
    const pullRequest = {
      number: 83581,
      head: {
        sha: "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f",
      },
    };
    const comments = [
      {
        user: {
          login: "clawsweeper[bot]",
          type: "Bot",
        },
        performed_via_github_app: {
          slug: "clawsweeper",
        },
        body: [
          "Codex review: passed.",
          "<!-- clawsweeper-verdict:pass item=83581 sha=06ee95df6608d29a395c52ba8ab53fdd93a9dc4f confidence=high -->",
        ].join("\n"),
      },
    ];

    expect(hasClawSweeperExactHeadProof({ pullRequest, comments })).toBe(true);
    expect(evaluateClawSweeperExactHeadProof({ pullRequest, comments }).passed).toBe(true);
    expect(
      hasClawSweeperExactHeadProof({
        pullRequest: {
          ...pullRequest,
          head: { sha: "d0215b2d67a45a783277fc7d2949ac4a30f63ec6" },
        },
        comments,
      }),
    ).toBe(false);
  });

  it("rejects forged ClawSweeper pass verdict markers from contributor comments", () => {
    const pullRequest = {
      number: 83581,
      head: {
        sha: "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f",
      },
    };
    const comments = [
      {
        user: {
          login: "external-contributor",
          type: "User",
        },
        body: "<!-- clawsweeper-verdict:pass item=83581 sha=06ee95df6608d29a395c52ba8ab53fdd93a9dc4f confidence=high -->",
      },
    ];

    expect(hasClawSweeperExactHeadProof({ pullRequest, comments })).toBe(false);
    expect(evaluateClawSweeperExactHeadProof({ pullRequest, comments }).passed).toBe(false);
  });

  it("accepts exact ClawSweeper bot pass verdict markers when GitHub omits the app source", () => {
    const pullRequest = {
      number: 83581,
      head: {
        sha: "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f",
      },
    };
    const comments = [
      {
        user: {
          login: "clawsweeper[bot]",
          type: "Bot",
        },
        body: "<!-- clawsweeper-verdict:pass item=83581 sha=06ee95df6608d29a395c52ba8ab53fdd93a9dc4f confidence=high -->",
      },
    ];

    expect(hasClawSweeperExactHeadProof({ pullRequest, comments })).toBe(true);
    expect(evaluateClawSweeperExactHeadProof({ pullRequest, comments }).passed).toBe(true);
  });

  it("accepts exact OpenClaw ClawSweeper bot pass verdict markers when GitHub omits the app source", () => {
    const pullRequest = {
      number: 83581,
      head: {
        sha: "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f",
      },
    };
    const comments = [
      {
        user: {
          login: "openclaw-clawsweeper[bot]",
          type: "Bot",
        },
        body: "<!-- clawsweeper-verdict:pass item=83581 sha=06ee95df6608d29a395c52ba8ab53fdd93a9dc4f confidence=high -->",
      },
    ];

    expect(hasClawSweeperExactHeadProof({ pullRequest, comments })).toBe(true);
    expect(evaluateClawSweeperExactHeadProof({ pullRequest, comments }).passed).toBe(true);
  });

  it("rejects bot-shaped pass verdict markers from other bot users", () => {
    const pullRequest = {
      number: 83581,
      head: {
        sha: "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f",
      },
    };
    const comments = [
      {
        user: {
          login: "not-clawsweeper[bot]",
          type: "Bot",
        },
        body: "<!-- clawsweeper-verdict:pass item=83581 sha=06ee95df6608d29a395c52ba8ab53fdd93a9dc4f confidence=high -->",
      },
    ];

    expect(hasClawSweeperExactHeadProof({ pullRequest, comments })).toBe(false);
    expect(evaluateClawSweeperExactHeadProof({ pullRequest, comments }).passed).toBe(false);
  });
});

describe("isMaintainerTeamMember", () => {
  function jsonResponse(status: number, body: unknown = {}) {
    return new Response(JSON.stringify(body), { status });
  }

  it("returns true for active members", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { state: "active" }));
    const result = await isMaintainerTeamMember({
      token: "tok",
      org: "openclaw",
      login: "private-maint",
      fetch,
    });

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/orgs/openclaw/teams/maintainer/memberships/private-maint",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          Accept: "application/vnd.github+json",
        }),
      }),
    );
  });

  it("returns false for non-active membership states", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { state: "pending" }));
    expect(await isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch })).toBe(false);
  });

  it("returns false when GitHub returns 404", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(404));
    expect(await isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch })).toBe(false);
  });

  it("cancels 404 membership response bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { status: 404 },
    );
    const fetch = vi.fn().mockResolvedValue(response);

    expect(await isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch })).toBe(false);
    expect(canceled).toBe(true);
  });

  it("returns false when the token, org, or login is missing", async () => {
    const fetch = vi.fn();
    expect(await isMaintainerTeamMember({ org: "o", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", login: "u", fetch })).toBe(false);
    expect(await isMaintainerTeamMember({ token: "t", org: "o", fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on unexpected HTTP errors so the caller can warn and fall back", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(500));
    await expect(
      isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch }),
    ).rejects.toThrow(/500/);
  });

  it("cancels unexpected HTTP error response bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { status: 500 },
    );
    const fetch = vi.fn().mockResolvedValue(response);

    await expect(
      isMaintainerTeamMember({ token: "t", org: "o", login: "u", fetch }),
    ).rejects.toThrow(/500/);
    expect(canceled).toBe(true);
  });

  it("aborts stalled membership fetches", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(toLintErrorObject(init.signal?.reason, "Non-Error rejection")),
        );
      });
    });

    await expect(
      isMaintainerTeamMember({
        fetch: fetch as typeof globalThis.fetch,
        login: "u",
        org: "o",
        timeoutMs: 5,
        token: "t",
      }),
    ).rejects.toThrow(/maintainer membership lookup for u timed out after 5ms/);
  });

  it("times out stalled membership response bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(stalledResponse());

    await expect(
      isMaintainerTeamMember({
        fetch: fetch as typeof globalThis.fetch,
        login: "u",
        org: "o",
        timeoutMs: 5,
        token: "t",
      }),
    ).rejects.toThrow(/maintainer membership response for u timed out after 5ms/);
  });
});

describe("readBoundedGitHubApiJson", () => {
  it("reads bounded JSON response bodies", async () => {
    await expect(
      readBoundedGitHubApiJson(new Response('{"state":"active"}'), "GitHub API", 1024),
    ).resolves.toEqual({ state: "active" });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    const response = contentLengthResponse(1025);

    await expect(
      readBoundedGitHubApiJson(response as unknown as Response, "GitHub API", 1024),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "GitHub API response body exceeded 1024 bytes",
    });
    expect(response.cancel).toHaveBeenCalled();
  });

  it("rejects oversized streamed JSON bodies", async () => {
    const encoder = new TextEncoder();
    const response = chunkedResponse([
      encoder.encode('{"body":"'),
      encoder.encode("x".repeat(1024)),
      encoder.encode('"}'),
    ]);

    await expect(
      readBoundedGitHubApiJson(response as unknown as Response, "GitHub API", 1024),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "GitHub API response body exceeded 1024 bytes",
    });
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
