// Verifies ClawHub skill icons, telemetry, metadata, verification, and cards.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClawHubPluginInstallTelemetry } from "./clawhub-packages.js";
import {
  fetchClawHubSkillCard,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillSecurityVerdicts,
  fetchClawHubSkillVerification,
  reportClawHubSkillInstallTelemetry,
  searchClawHubSkills,
} from "./clawhub-skills.js";

function malformedUtf8(prefix: string, suffix: string): ArrayBuffer {
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const buffer = new ArrayBuffer(prefixBytes.byteLength + 1 + suffixBytes.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(prefixBytes);
  bytes[prefixBytes.byteLength] = 0xff;
  bytes.set(suffixBytes, prefixBytes.byteLength + 1);
  return buffer;
}

describe("clawhub skills", () => {
  afterEach(() => {
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
  });

  it("resolves hosted skill icons against the configured ClawHub origin", async () => {
    await expect(
      searchClawHubSkills({
        query: "playwright",
        baseUrl: "https://registry.example",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  score: 1,
                  slug: "playwright-interactive",
                  ownerHandle: "acme",
                  displayName: "Playwright Interactive",
                  source: "clawhub",
                  install: { kind: "clawhub", reference: "acme/playwright-interactive" },
                  icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
    ).resolves.toMatchObject([
      {
        icon: `https://registry.example/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    ]);
  });

  it("rejects skill icons outside the configured hosted-icon route", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              score: 1,
              slug: "external",
              ownerHandle: "acme",
              displayName: "External",
              source: "clawhub",
              install: { kind: "clawhub", reference: "acme/external" },
              icon: `https://tracker.example/api/v1/skill-icons/${"a".repeat(64)}`,
            },
            {
              score: 1,
              slug: "wrong-path",
              ownerHandle: "acme",
              displayName: "Wrong Path",
              source: "clawhub",
              install: { kind: "clawhub", reference: "acme/wrong-path" },
              icon: "https://registry.example/icon.png",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await expect(
      searchClawHubSkills({ query: "icons", baseUrl: "https://registry.example", fetchImpl }),
    ).resolves.toMatchObject([{ icon: undefined }, { icon: undefined }]);
  });

  it("keeps each search result on its own source and marks which ones are install-only", async () => {
    // Shape copied from a live https://clawhub.ai/api/v1/search response: the origin of a result
    // arrives under `install`, never as a flat `installRef`.
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              score: 2,
              slug: "email",
              ownerHandle: "alice",
              displayName: "Email",
              source: "clawhub",
              install: { kind: "clawhub", reference: "alice/email" },
            },
            {
              score: 1,
              slug: "email",
              ownerHandle: "bob",
              displayName: "Email",
              source: "clawhub",
              install: { kind: "clawhub", reference: "bob/email" },
            },
            {
              score: 1,
              slug: "weather",
              ownerHandle: "openclaw",
              displayName: "Weather",
              source: "skills-sh",
              install: { kind: "skills-sh", reference: "skills-sh:openclaw/skills/weather" },
            },
            {
              score: 1,
              slug: "github-backed",
              ownerHandle: "openclaw",
              displayName: "GitHub backed",
              source: "clawhub",
              install: { kind: "github", reference: "openclaw/github-backed" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await expect(
      searchClawHubSkills({ query: "email", baseUrl: "https://registry.example", fetchImpl }).then(
        (results) =>
          results.map((entry) => ({
            installRef: entry.installRef,
            installOnly: entry.installOnly,
            trustState: entry.trustState,
          })),
      ),
    ).resolves.toEqual([
      { installRef: "@alice/email", installOnly: undefined, trustState: undefined },
      { installRef: "@bob/email", installOnly: undefined, trustState: undefined },
      // The external row keeps its own reference and stays out of detail; rewriting it to
      // `@openclaw/weather` would install a different publisher's skill.
      {
        installRef: "skills-sh:openclaw/skills/weather",
        installOnly: true,
        trustState: "not-scanned-by-clawhub",
      },
      { installRef: "@openclaw/github-backed", installOnly: undefined, trustState: undefined },
    ]);
  });

  it("drops rows whose source or reference cannot be identified", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            // External row without its own reference: publishing it under `@acme/weather` would
            // install a different publisher's skill, and there is no other identity to install.
            {
              score: 1,
              slug: "weather",
              ownerHandle: "acme",
              displayName: "Weather",
              source: "skills-sh",
              install: { kind: "skills-sh", reference: null },
            },
            // Native row without a publisher: every action on the bare slug answers 409.
            {
              score: 1,
              slug: "orphan",
              displayName: "Orphan",
              source: "clawhub",
              install: { kind: "clawhub", reference: "orphan" },
            },
            // Unknown source: nothing here says which artifact an install would resolve.
            {
              score: 1,
              slug: "mystery",
              ownerHandle: "acme",
              displayName: "Mystery",
              source: "future-registry",
              install: { kind: "future-registry", reference: "acme/mystery" },
            },
            // A known source still needs a supported delivery mechanism.
            {
              score: 1,
              slug: "future-install",
              ownerHandle: "acme",
              displayName: "Future install",
              source: "clawhub",
              install: { kind: "future-transport", reference: "acme/future-install" },
            },
            {
              score: 1,
              slug: "keep",
              ownerHandle: "acme",
              displayName: "Keep",
              source: "clawhub",
              install: { kind: "clawhub", reference: "acme/keep" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await expect(
      searchClawHubSkills({
        query: "weather",
        baseUrl: "https://registry.example",
        fetchImpl,
      }).then((results) => results.map((entry) => entry.installRef)),
    ).resolves.toEqual(["@acme/keep"]);
  });

  it("preserves the legacy telemetry opt-out when the primary env is blank", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "   ";
    process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "calendar",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends canonical plugin install telemetry", async () => {
    let requestBody: unknown;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      requestBody = JSON.parse(init.body) as unknown;
      return new Response(null, { status: 200 });
    });

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
      fetchImpl,
    });

    expect(requestBody).toEqual({
      event: "plugin_install",
      packageName: "@openclaw/voice-call",
      version: "2026.7.23",
    });
  });

  it("applies the install telemetry opt-out to plugin reports", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubPluginInstallTelemetry({
      token: "test-token",
      packageName: "@openclaw/voice-call",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves skills-sh references in install telemetry", async () => {
    let body: unknown;

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "weather",
      version: "a".repeat(40),
      requestedReference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
      fetchImpl: async (_input, init) => {
        expect(typeof init?.body).toBe("string");
        body = JSON.parse(init?.body as string);
        return new Response(null, { status: 200 });
      },
    });

    expect(body).toMatchObject({
      event: "install",
      slug: "weather",
      version: "a".repeat(40),
      reference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
    });
  });

  it("treats an empty primary telemetry setting as absent", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "";
    process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "calendar",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets a nonblank primary telemetry setting override the legacy opt-out", async () => {
    process.env.CLAWHUB_DISABLE_TELEMETRY = "false";
    process.env.CLAWDHUB_DISABLE_TELEMETRY = "true";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await reportClawHubSkillInstallTelemetry({
      token: "test-token",
      slug: "calendar",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends owner-qualified skill detail lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillDetail({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              skill: {
                slug: "weather",
                displayName: "Weather",
                icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
                createdAt: 1,
                updatedAt: 2,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({
      skill: {
        slug: "weather",
        icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      },
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("sends owner-qualified skill install resolution lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillInstallResolution({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              ok: true,
              slug: "weather",
              installKind: "archive",
              archive: {
                version: "1.0.0",
                downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({ ok: true, slug: "weather" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/install");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("sends skills-sh references to the ClawHub install resolver", async () => {
    let requestedUrl = "";
    const reference = "skills-sh:openclaw/skills/weather";

    await fetchClawHubSkillInstallResolution({
      slug: "weather",
      requestedReference: reference,
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return new Response(
          JSON.stringify({
            ok: true,
            slug: "weather",
            installKind: "github",
            trust: { state: "not-scanned-by-clawhub" },
            github: {
              repo: "openclaw/skills",
              path: "skills/weather",
              commit: "a".repeat(40),
              contentHash: "sha256:approved",
              sourceUrl: "https://github.com/openclaw/skills",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/install");
    expect(url.searchParams.get("reference")).toBe(reference);
  });

  it("fetches skill verification reports and lets version take precedence over tag", async () => {
    let requestedUrl = "";
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.2.3", tag: "stable" },
      card: {
        available: true,
        url: "https://clawhub.ai/api/v1/skills/agentreceipt/card?version=1.2.3",
      },
      artifact: {
        sourceFingerprint: "source-fp",
        bundleFingerprints: ["generated-bundle-fp"],
      },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        version: "1.2.3",
        tag: "stable",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/verify");
    expect(url.searchParams.get("version")).toBe("1.2.3");
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("sends owner-qualified skill verification lookups without resolved auth when requested", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;

    await expect(
      fetchClawHubSkillVerification({
        slug: "weather",
        ownerHandle: "demo-owner",
        version: "1.0.0",
        skipAuth: true,
        fetchImpl: async (input, init) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          requestedInit = init;
          return new Response(
            JSON.stringify({
              schema: "clawhub.skill.verify.v1",
              ok: true,
              decision: "pass",
              reasons: [],
              skill: {},
              publisher: {},
              version: {},
              card: {},
              artifact: {},
              provenance: {},
              security: {},
              signature: {},
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({ schema: "clawhub.skill.verify.v1" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/verify");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
    expect(url.searchParams.get("version")).toBe("1.0.0");
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
  });

  it("posts bulk skill security verdict requests", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          slug: "agentreceipt",
          requestedVersion: "1.2.3",
          version: "1.2.3",
          security: { status: "clean", passed: true },
        },
      ],
    };

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
        fetchImpl: async (input, init) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          requestedInit = init;
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requestedInit?.body).toBe(
      JSON.stringify({
        items: [{ slug: "agentreceipt", ownerHandle: "openclaw", version: "1.2.3" }],
      }),
    );
  });

  it("can post bulk skill security verdict requests without resolved auth", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    let requestedInit: RequestInit | undefined;
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [],
    };

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", version: "1.2.3" }],
        skipAuth: true,
        fetchImpl: async (_input, init) => {
          requestedInit = init;
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
  });

  it("returns failed skill verification reports with missing card reasons", async () => {
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["card.missing"],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: false },
      artifact: null,
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () =>
          new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).resolves.toEqual(envelope);
  });

  it("fetches generated Skill Card markdown and applies tag queries", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        tag: "latest",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response("# Agent Receipt\n\nVerified by ClawHub.\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n\nVerified by ClawHub.\n");

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/card");
    expect(url.searchParams.get("tag")).toBe("latest");
    expect(url.searchParams.has("version")).toBe(false);
  });

  it("clamps oversized ClawHub request timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        fetchClawHubSkillCard({
          slug: "agentreceipt",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          fetchImpl: async () =>
            new Response("# Agent Receipt\n", {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            }),
        }),
      ).resolves.toBe("# Agent Receipt\n");

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("rejects malformed UTF-8 in generated Skill Card markdown", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response(malformedUtf8("# Agent ", "\n")),
      }),
    ).rejects.toThrow(TypeError);
  });

  it("fetches generated Skill Card markdown from an exact verified card URL", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        url: "https://cards.example.test/generated/agentreceipt.md",
        baseUrl: "https://clawhub.ai",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response("# Agent Receipt\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n");

    expect(requestedUrl).toBe("https://cards.example.test/generated/agentreceipt.md");
  });

  it("wraps non-200 skill card responses", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("card missing", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/card failed (404): card missing");
  });

  it("rejects oversized generated Skill Card markdown", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)),
      }),
    ).rejects.toThrow(
      "ClawHub skill card for agentreceipt exceeded 262144 bytes (262145 bytes received)",
    );
  });

  it("wraps non-200 skill verification responses", async () => {
    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("not found", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/verify failed (404): not found");
  });
});
