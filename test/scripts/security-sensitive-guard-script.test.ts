// Security Sensitive Guard Script tests cover sensitive file guard behavior.
import { describe, expect, it } from "vitest";
import {
  GITHUB_RESPONSE_BODY_MAX_BYTES,
  allowSecuritySensitiveCommand,
  collectSecuritySensitiveChanges,
  findSecuritySensitiveOverrideCommand,
  findSecuritySensitiveOverrideCommandAsync,
  findTrustedSecuritySensitiveGuardActor,
  githubApi,
  isSecuritySensitiveFile,
  isSecuritySensitiveGuardAuthorizedForHead,
  isSecuritySensitiveGuardMarkerComment,
  isSecuritySensitiveGuardTrustedForHead,
  markdownCode,
  renderAuthorizedSecuritySensitiveComment,
  renderBlockedSecuritySensitiveComment,
  renderClearedSecuritySensitiveGuardComment,
  renderSecuritySensitiveAwarenessComment,
  renderTrustedSecuritySensitiveComment,
  sanitizeDisplayValue,
  securityApproverSet,
  securitySensitiveFileDefinition,
  securitySensitiveFileDefinitions,
  securitySensitiveGuardCommentAuthors,
  securitySensitiveGuardCommentHeadSha,
  securitySensitiveGuardMarker,
  securitySensitiveGuardTrustedActorCandidates,
  securitySensitiveOverrideExpectedSha,
} from "../../scripts/github/security-sensitive-guard.mjs";

const headSha = "a".repeat(40);
const staleSha = "b".repeat(40);

describe("security-sensitive guard script", () => {
  it("detects only registered security-sensitive file surfaces", () => {
    expect(securitySensitiveFileDefinitions()).toEqual([
      {
        path: ".gitignore",
        reason:
          "Controls ignored secret and local files, including common `.env` files, before they can be accidentally committed.",
      },
    ]);
    expect(isSecuritySensitiveFile(".gitignore")).toBe(true);
    expect(isSecuritySensitiveFile("docs/.gitignore")).toBe(false);
    expect(isSecuritySensitiveFile("package.json")).toBe(false);
    expect(securitySensitiveFileDefinition(".gitignore")?.reason).toContain(".env");
  });

  it("detects renames away from registered security-sensitive file surfaces", () => {
    expect(
      collectSecuritySensitiveChanges([
        {
          filename: ".gitignore.disabled",
          previous_filename: ".gitignore",
          status: "renamed",
        },
      ]),
    ).toEqual([securitySensitiveFileDefinition(".gitignore")]);
  });

  it("accepts only security-member override commands for the current head sha", () => {
    const comments = [
      {
        body: "/allow-security-sensitive-change not enough",
        created_at: "2026-05-28T20:00:00Z",
        user: { login: "not-security" },
      },
      {
        body: "/allow-security-sensitive-change stale approval",
        created_at: "2026-05-28T20:01:00Z",
        user: { login: "security-user" },
      },
      {
        body: "/allow-security-sensitive-change reviewed .gitignore",
        created_at: "2026-05-28T20:03:00Z",
        html_url: "https://example.test/comment",
        user: { login: "security-user" },
      },
    ];

    const override = findSecuritySensitiveOverrideCommand({
      comments,
      expectedSha: headSha,
      isSecurityMember: (login) => login === "security-user",
      newerThan: "2026-05-28T20:02:00Z",
    });

    expect(override).toEqual({
      login: "security-user",
      reason: "reviewed .gitignore",
      sha: headSha,
      url: "https://example.test/comment",
    });
  });

  it("rejects stale or non-security override commands", async () => {
    const comments = [
      {
        body: "/allow-security-sensitive-change stale approval",
        created_at: "2026-05-28T20:00:00Z",
        user: { login: "security-user" },
      },
      {
        body: "/allow-security-sensitive-change not enough",
        created_at: "2026-05-28T20:02:00Z",
        user: { login: "not-security" },
      },
    ];

    await expect(
      findSecuritySensitiveOverrideCommandAsync({
        comments,
        expectedSha: headSha,
        isSecurityMember: async (login) => login === "security-user",
        newerThan: "2026-05-28T20:01:00Z",
      }),
    ).resolves.toBeNull();
  });

  it("binds override commands to the head sha in the blocked guard comment", () => {
    const blockedComment = {
      body: renderBlockedSecuritySensitiveComment({
        changes: [securitySensitiveFileDefinition(".gitignore")],
        headSha,
      }),
    };
    const staleBlockedComment = {
      body: renderBlockedSecuritySensitiveComment({
        changes: [securitySensitiveFileDefinition(".gitignore")],
        headSha: staleSha,
      }),
    };

    expect(securitySensitiveGuardCommentHeadSha(blockedComment)).toBe(headSha);
    expect(securitySensitiveOverrideExpectedSha(blockedComment, headSha)).toBe(headSha);
    expect(securitySensitiveOverrideExpectedSha(staleBlockedComment, headSha)).toBeNull();
  });

  it("preserves same-head authorization across reruns", () => {
    const authorizedComment = {
      body: renderAuthorizedSecuritySensitiveComment({
        login: "security-user",
        reason: null,
        sha: headSha,
      }),
    };

    expect(securitySensitiveGuardCommentHeadSha(authorizedComment)).toBe(headSha);
    expect(isSecuritySensitiveGuardAuthorizedForHead(authorizedComment, headSha)).toBe(true);
    expect(isSecuritySensitiveGuardAuthorizedForHead(authorizedComment, staleSha)).toBe(false);
    expect(securitySensitiveOverrideExpectedSha(authorizedComment, headSha)).toBeNull();
  });

  it("recognizes trusted security-sensitive guard actors automatically", async () => {
    const sameActorCandidates = securitySensitiveGuardTrustedActorCandidates({
      pullRequest: { user: { login: "repo-admin" } },
      event: { pull_request: { head: { sha: headSha } }, sender: { login: "repo-admin" } },
      currentHeadSha: headSha,
    });
    const staleAuthorCandidate = securitySensitiveGuardTrustedActorCandidates({
      pullRequest: { user: { login: "repo-admin" } },
      event: { pull_request: { head: { sha: staleSha } }, sender: { login: "repo-admin" } },
      currentHeadSha: headSha,
    });

    expect(sameActorCandidates).toEqual([{ login: "repo-admin", source: "pull request author" }]);
    expect(staleAuthorCandidate).toEqual([]);

    await expect(
      findTrustedSecuritySensitiveGuardActor({
        candidates: sameActorCandidates,
        isSecuritySensitiveApprover: async (login) =>
          login === "repo-admin" ? "repository admin" : null,
      }),
    ).resolves.toEqual({
      login: "repo-admin",
      reason: "pull request author; repository admin",
    });
  });

  it("trusts only configured security-sensitive guard marker comment authors", () => {
    const trustedAuthors = securitySensitiveGuardCommentAuthors(
      "github-actions[bot], openclaw-security-guard[bot]",
    );

    expect(
      isSecuritySensitiveGuardMarkerComment(
        {
          body: securitySensitiveGuardMarker,
          user: { login: "openclaw-security-guard[bot]" },
        },
        trustedAuthors,
      ),
    ).toBe(true);
    expect(
      isSecuritySensitiveGuardMarkerComment(
        {
          body: securitySensitiveGuardMarker,
          user: { login: "contributor" },
        },
        trustedAuthors,
      ),
    ).toBe(false);
  });

  it("renders deterministic awareness, blocked, trusted, authorized, and cleared comments", () => {
    const changes = [securitySensitiveFileDefinition(".gitignore")!];
    const awarenessBody = renderSecuritySensitiveAwarenessComment(changes);
    const blockedBody = renderBlockedSecuritySensitiveComment({ changes, headSha });
    const trustedBody = renderTrustedSecuritySensitiveComment({
      actor: { login: "repo-admin", reason: "pull request author; repository admin" },
      changes,
      headSha,
    });
    const authorizedBody = renderAuthorizedSecuritySensitiveComment({
      login: "security-user",
      reason: "reviewed .gitignore",
      sha: headSha,
    });
    const clearedBody = renderClearedSecuritySensitiveGuardComment({ headSha });

    expect(awarenessBody).toContain(securitySensitiveGuardMarker);
    expect(awarenessBody).toContain("Security-sensitive file changes detected");
    expect(awarenessBody).toContain("`.gitignore`");
    expect(awarenessBody).toContain(".env");
    expect(blockedBody).toContain("Security-sensitive changes are blocked");
    expect(blockedBody).toContain(allowSecuritySensitiveCommand);
    expect(blockedBody).toContain(`current head SHA (\`${headSha}\`)`);
    expect(trustedBody).toContain("Security-sensitive changes noted");
    expect(trustedBody).toContain("@repo-admin");
    expect(isSecuritySensitiveGuardTrustedForHead({ body: trustedBody }, headSha)).toBe(true);
    expect(authorizedBody).toContain("Security-sensitive change authorized");
    expect(authorizedBody).toContain("`reviewed .gitignore`");
    expect(clearedBody).toContain("Security-sensitive guard cleared");
    expect(clearedBody).toContain("requires a fresh `/allow-security-sensitive-change` comment");
  });

  it("sanitizes display values and markdown code", () => {
    expect(sanitizeDisplayValue("abc\u0000def")).toBe("abc?def");
    expect(sanitizeDisplayValue("x".repeat(300))).toHaveLength(240);
    expect(markdownCode("`quoted`")).toBe("`\\`quoted\\``");
  });

  it("parses explicit security approver allowlists", () => {
    expect(securityApproverSet("vincentkoc, steipete\njoshavant")).toEqual(
      new Set(["vincentkoc", "steipete", "joshavant"]),
    );
  });

  it("bounds successful GitHub API response bodies", async () => {
    const request = githubApi("token", {
      responseMaxBodyBytes: 64,
      fetchImpl: (() =>
        Promise.resolve(
          new Response("x".repeat(65), {
            headers: { "content-length": "65" },
          }),
        )) as typeof fetch,
    }).request("/repos/openclaw/openclaw");

    await expect(request).rejects.toThrow("GitHub response body exceeded 64 bytes");
    expect(GITHUB_RESPONSE_BODY_MAX_BYTES).toBeGreaterThan(64);
  });
});
