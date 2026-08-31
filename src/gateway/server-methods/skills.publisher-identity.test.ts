// Boundary proof for issue #117633: two publishers share one ClawHub slug, and the reference a
// client picks from skills.search must reach the outbound ClawHub request unchanged. Only the
// HTTP layer is faked here; search, the Gateway handlers, and the detail client are real.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installSkillFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/lifecycle/clawhub.js")>()),
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
}));

const { skillsHandlers } = await import("./skills.js");
const { callGatewayHandler } = await import("./skills.test-helpers.js");

const SLUG = "imap-smtp-email";
const PUBLISHERS = ["gzlicanyi", "wangchenyu8"] as const;

function searchPayload() {
  return {
    results: [
      ...PUBLISHERS.map((ownerHandle, index) => ({
        score: 6120 - index,
        slug: SLUG,
        ownerHandle,
        displayName: SLUG,
        summary: `Email skill by ${ownerHandle}`,
        version: "1.0.0",
        source: "clawhub",
        install: { kind: "clawhub", reference: `${ownerHandle}/${SLUG}` },
      })),
      // An external source that names its own reference instead of a registry publisher.
      {
        score: 6100,
        slug: SLUG,
        ownerHandle: "acme",
        displayName: SLUG,
        summary: "Email skill from skills.sh",
        version: "1.0.0",
        source: "skills-sh",
        install: { kind: "skills-sh", reference: `skills-sh:acme/tools/${SLUG}` },
      },
    ],
  };
}

let requestedUrls: string[] = [];

function fakeClawHub(input: string): Response {
  const url = new URL(input);
  requestedUrls.push(input);
  if (url.pathname === "/api/v1/search") {
    return Response.json(searchPayload());
  }
  if (url.pathname === `/api/v1/skills/${SLUG}`) {
    const ownerHandle = url.searchParams.get("ownerHandle");
    if (!ownerHandle) {
      // Real ClawHub refuses to guess a publisher instead of returning an arbitrary match.
      return Response.json(
        { code: "AMBIGUOUS_SKILL_SLUG", message: `Found multiple skills with the slug "${SLUG}"` },
        { status: 409 },
      );
    }
    return Response.json({
      skill: { slug: SLUG, displayName: SLUG, createdAt: 1, updatedAt: 2 },
      owner: { handle: ownerHandle, displayName: ownerHandle },
    });
  }
  throw new Error(`unexpected ClawHub request: ${input}`);
}

const callSkillsHandler = (method: string, params: Record<string, unknown>) =>
  callGatewayHandler(skillsHandlers, method, params);

describe("ClawHub publisher identity across skills.search, skills.detail, and skills.install", () => {
  beforeEach(() => {
    requestedUrls = [];
    installSkillFromClawHubMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => fakeClawHub(input instanceof URL ? input.href : input)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives each same-slug publisher its own install reference", async () => {
    const { ok, response } = await callSkillsHandler("skills.search", { query: SLUG });

    expect(ok).toBe(true);
    const results = (response as { results: { installRef?: string; installOnly?: true }[] })
      .results;
    expect(results.map((r) => r.installRef)).toEqual([
      `@gzlicanyi/${SLUG}`,
      `@wangchenyu8/${SLUG}`,
      `skills-sh:acme/tools/${SLUG}`,
    ]);
    // Only the external row is install-only; the registry rows keep the review flow.
    expect(results.map((r) => r.installOnly)).toEqual([undefined, undefined, true]);
  });

  it.each(PUBLISHERS)("reads detail for the selected publisher %s", async (ownerHandle) => {
    const { ok, response, error } = await callSkillsHandler("skills.detail", {
      slug: `@${ownerHandle}/${SLUG}`,
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect((response as { owner: { handle: string } }).owner.handle).toBe(ownerHandle);
    const detailUrl = expectDefined(
      requestedUrls.find((url) => url.includes(`/api/v1/skills/${SLUG}`)),
      "detail request",
    );
    expect(new URL(detailUrl).searchParams.get("ownerHandle")).toBe(ownerHandle);
  });

  it("surfaces the ambiguous-slug error instead of picking a publisher for a bare slug", async () => {
    const { ok, error } = await callSkillsHandler("skills.detail", { slug: SLUG });

    expect(ok).toBe(false);
    expect(String((error as { message?: string }).message)).toContain("AMBIGUOUS_SKILL_SLUG");
  });

  it("refuses external-source detail instead of reading a same-slug registry skill", async () => {
    // Install keeps the external source, so a bare-slug read here would let an operator review
    // one skill and install another. ClawHub has no source-qualified read endpoint yet.
    const { ok, error } = await callSkillsHandler("skills.detail", {
      slug: `skills-sh:openclaw/skills/${SLUG}`,
    });

    expect(ok).toBe(false);
    expect((error as { code?: string }).code).toBe("INVALID_REQUEST");
    expect(requestedUrls.some((url) => url.includes("/api/v1/skills/"))).toBe(false);
  });

  it("forwards the selected publisher reference to the install lifecycle unchanged", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: SLUG,
      version: "1.0.0",
      targetDir: `/tmp/workspace/skills/${SLUG}`,
    });

    const { ok } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: `@wangchenyu8/${SLUG}`,
    });

    expect(ok).toBe(true);
    expect(installSkillFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: `@wangchenyu8/${SLUG}` }),
    );
  });
});
