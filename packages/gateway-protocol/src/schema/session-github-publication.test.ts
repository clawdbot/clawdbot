import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionGitHubPublicationResultSchema,
  SessionGitHubPublishParamsSchema,
} from "./session-github-publication.js";

describe("session GitHub publication protocol", () => {
  it("accepts bounded intent without caller-owned repository authority", () => {
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway",
        body: "Explains the change.",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway\nCo-authored-by: unverified <unverified@example.test>",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway",
        commitMessage: "model-controlled trailer",
      }),
    ).toBe(false);
  });

  it.each([
    ["token", "secret"],
    ["repository", "openclaw/openclaw"],
    ["branch", "main"],
  ])("rejects caller-owned %s authority independently", (field, value) => {
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        [field]: value,
      }),
    ).toBe(false);
  });

  it.each([
    {
      requestId: "request-1",
      status: "requested",
      message: "Publication was accepted.",
    },
    {
      requestId: "request-1",
      status: "publishing",
      message: "The Gateway is publishing.",
    },
    {
      requestId: "request-1",
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/1",
      repository: "openclaw/openclaw",
      branch: "openclaw/task",
      headCommit: "a".repeat(40),
    },
    {
      requestId: "request-1",
      status: "failed",
      code: "push_rejected",
      message: "GitHub publication failed.",
      nextAction: "Check branch access and retry.",
    },
  ])("accepts the closed $status result", (result) => {
    expect(Value.Check(SessionGitHubPublicationResultSchema, result)).toBe(true);
  });

  it("rejects extra fields from terminal results", () => {
    expect(
      Value.Check(SessionGitHubPublicationResultSchema, {
        requestId: "request-1",
        status: "failed",
        code: "push_rejected",
        message: "GitHub publication failed.",
        nextAction: "Check branch access and retry.",
        token: "secret",
      }),
    ).toBe(false);
  });
});
