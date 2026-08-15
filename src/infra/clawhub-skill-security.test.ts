import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchClawHubSkillSecurityVerdicts: vi.fn(),
  fetchClawHubSkillVerification: vi.fn(),
}));

vi.mock("./clawhub-skills.js", () => ({
  fetchClawHubSkillSecurityVerdicts: mocks.fetchClawHubSkillSecurityVerdicts,
  fetchClawHubSkillVerification: mocks.fetchClawHubSkillVerification,
}));

import { fetchExactClawHubSkillSecurityVerdicts } from "./clawhub-skill-security.js";

describe("fetchExactClawHubSkillSecurityVerdicts", () => {
  beforeEach(() => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockReset();
    mocks.fetchClawHubSkillVerification.mockReset();
  });

  it("uses exact unauthenticated verify fallbacks for owner collisions on older registries", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockImplementation(
      async ({ items }: { items: Array<{ slug: string; version: string }> }) => ({
        schema: "clawhub.skill.security-verdicts.v1",
        items: items.map((item) => ({
          ok: false,
          decision: "fail",
          reasons: ["skill.not_found"],
          requestedSlug: item.slug,
          requestedVersion: item.version,
          slug: item.slug,
          version: null,
          error: { code: "skill_not_found", message: "Skill not found" },
        })),
      }),
    );
    mocks.fetchClawHubSkillVerification.mockImplementation(
      async ({ ownerHandle }: { ownerHandle: string }) => ({
        schema: "clawhub.skill.verify.v1",
        ok: true,
        decision: "pass",
        reasons: [],
        slug: "weather",
        displayName: `${ownerHandle} Weather`,
        pageUrl: `https://clawhub.ai/${ownerHandle}/skills/weather`,
        publisherHandle: ownerHandle,
        publisherDisplayName: ownerHandle,
        createdAt: 1,
        skill: null,
        publisher: null,
        version: "1.2.3",
        card: null,
        artifact: null,
        provenance: null,
        security: { status: "clean", passed: true, checkedAt: 2 },
        signature: null,
      }),
    );

    const items = await fetchExactClawHubSkillSecurityVerdicts({
      baseUrl: "https://clawhub.ai",
      items: [
        { slug: "weather", ownerHandle: "@Alice", version: "1.2.3" },
        { slug: "weather", ownerHandle: "bob", version: "1.2.3" },
      ],
      skipAuth: true,
    });

    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenCalledTimes(2);
    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://clawhub.ai",
      items: [{ slug: "weather", ownerHandle: "alice", version: "1.2.3" }],
      skipAuth: true,
      timeoutMs: undefined,
      token: undefined,
    });
    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://clawhub.ai",
      items: [{ slug: "weather", ownerHandle: "bob", version: "1.2.3" }],
      skipAuth: true,
      timeoutMs: undefined,
      token: undefined,
    });
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(2);
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://clawhub.ai",
      ownerHandle: "alice",
      skipAuth: true,
      slug: "weather",
      timeoutMs: undefined,
      token: undefined,
      version: "1.2.3",
    });
    expect(items.map((item) => item.publisherHandle)).toEqual(["alice", "bob"]);
    expect(items.map((item) => item.requestedOwnerHandle)).toEqual(["alice", "bob"]);
  });

  it("bounds concurrent exact verify fallbacks on older registries", async () => {
    let activeFallbacks = 0;
    let maxActiveFallbacks = 0;
    let releaseFallbacks: (() => void) | undefined;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallbacks = resolve;
    });
    mocks.fetchClawHubSkillSecurityVerdicts.mockImplementation(
      async ({ items }: { items: Array<{ slug: string; version: string }> }) => ({
        schema: "clawhub.skill.security-verdicts.v1",
        items: items.map((item) => ({
          ok: false,
          decision: "fail",
          reasons: ["skill.not_found"],
          requestedSlug: item.slug,
          requestedVersion: item.version,
          slug: item.slug,
          version: null,
          error: { code: "skill_not_found", message: "Skill not found" },
        })),
      }),
    );
    mocks.fetchClawHubSkillVerification.mockImplementation(
      async ({
        slug,
        ownerHandle,
        version,
      }: {
        slug: string;
        ownerHandle: string;
        version: string;
      }) => {
        activeFallbacks += 1;
        maxActiveFallbacks = Math.max(maxActiveFallbacks, activeFallbacks);
        await fallbackGate;
        activeFallbacks -= 1;
        return {
          schema: "clawhub.skill.verify.v1",
          ok: true,
          decision: "pass",
          reasons: [],
          slug,
          publisherHandle: ownerHandle,
          version,
          skill: null,
          publisher: null,
          card: null,
          artifact: null,
          provenance: null,
          security: { status: "clean", passed: true },
          signature: null,
        };
      },
    );
    const targets = Array.from({ length: 8 }, (_, index) => ({
      slug: `skill-${index}`,
      ownerHandle: `owner-${index}`,
      version: "1.0.0",
    }));

    const resultPromise = fetchExactClawHubSkillSecurityVerdicts({ items: targets });
    await vi.waitFor(() => expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(6));
    expect(maxActiveFallbacks).toBe(6);
    releaseFallbacks?.();

    await expect(resultPromise).resolves.toHaveLength(8);
    expect(mocks.fetchClawHubSkillVerification).toHaveBeenCalledTimes(8);
    expect(maxActiveFallbacks).toBe(6);
  });

  it("correlates reordered batches and fails closed on publisher mismatches", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockResolvedValue({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "calendar",
          requestedOwnerHandle: "bob",
          requestedVersion: "2.0.0",
          slug: "calendar",
          version: "2.0.0",
          publisherHandle: "mallory",
          security: { status: "clean", passed: true },
        },
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "weather",
          requestedOwnerHandle: "alice",
          requestedVersion: "1.2.3",
          slug: "weather",
          version: "1.2.3",
          publisherHandle: "alice",
          security: { status: "clean", passed: true },
        },
      ],
    });

    const items = await fetchExactClawHubSkillSecurityVerdicts({
      items: [
        { slug: "weather", ownerHandle: "alice", version: "1.2.3" },
        { slug: "calendar", ownerHandle: "bob", version: "2.0.0" },
      ],
      skipAuth: true,
    });

    expect(mocks.fetchClawHubSkillSecurityVerdicts).toHaveBeenCalledTimes(1);
    expect(items[0]).toMatchObject({
      ok: true,
      requestedOwnerHandle: "alice",
      publisherHandle: "alice",
    });
    expect(items[1]).toMatchObject({
      ok: false,
      requestedOwnerHandle: "bob",
      reasons: ["security.identity_mismatch"],
      error: { code: "identity_mismatch" },
    });
    expect(mocks.fetchClawHubSkillVerification).not.toHaveBeenCalled();
  });

  it("fails closed when a successful verdict returns a different exact version", async () => {
    mocks.fetchClawHubSkillSecurityVerdicts.mockResolvedValue({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "weather",
          requestedOwnerHandle: "alice",
          requestedVersion: "1.2.3",
          slug: "weather",
          version: "1.2.4",
          publisherHandle: "alice",
          security: { status: "clean", passed: true },
        },
      ],
    });

    const [item] = await fetchExactClawHubSkillSecurityVerdicts({
      items: [{ slug: "weather", ownerHandle: "alice", version: "1.2.3" }],
    });

    expect(item).toMatchObject({
      ok: false,
      requestedOwnerHandle: "alice",
      requestedVersion: "1.2.3",
      reasons: ["security.identity_mismatch"],
      error: { code: "identity_mismatch" },
    });
  });
});
