import { describe, expect, it, vi } from "vitest";
import {
  addQaCredentialSet,
  diagnoseQaCredentialBroker,
  listQaCredentialSets,
  QaCredentialAdminError,
  removeQaCredentialSet,
} from "./qa-credentials-admin.runtime.js";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("qa credential admin runtime", () => {
  it("adds a credential set through the admin endpoint", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "ok",
        credential: {
          credentialId: "cred-1",
          kind: "telegram",
          status: "active",
          createdAtMs: 100,
          updatedAtMs: 100,
          lastLeasedAtMs: 0,
          note: "qa",
        },
      }),
    );

    const result = await addQaCredentialSet({
      kind: "telegram",
      payload: {
        groupId: "-100123",
        driverToken: "driver",
        sutToken: "sut",
      },
      note: "qa",
      actorId: "maintainer-local",
      siteUrl: "https://first-schnauzer-821.convex.site",
      env: {
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
      },
      fetchImpl,
    });

    expect(result.credential.credentialId).toBe("cred-1");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://first-schnauzer-821.convex.site/qa-credentials/v1/admin/add");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maint-secret");
    const bodyText = init?.body;
    expect(typeof bodyText).toBe("string");
    const body = JSON.parse(bodyText as string) as Record<string, unknown>;
    expect(body.kind).toBe("telegram");
    expect(body.actorId).toBe("maintainer-local");
    expect(body.payload).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
  });

  it("rejects admin commands when maintainer secret is missing", async () => {
    await expect(
      listQaCredentialSets({
        siteUrl: "https://first-schnauzer-821.convex.site",
        env: {},
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: "QaCredentialAdminError",
      code: "MISSING_MAINTAINER_SECRET",
    } satisfies Partial<QaCredentialAdminError>);
  });

  it("rejects non-https admin site URLs unless local insecure opt-in is enabled", async () => {
    await expect(
      listQaCredentialSets({
        siteUrl: "http://qa-cred.example.convex.site",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: "QaCredentialAdminError",
      code: "INVALID_SITE_URL",
    } satisfies Partial<QaCredentialAdminError>);
  });

  it("allows loopback http admin site URLs when OPENCLAW_QA_ALLOW_INSECURE_HTTP is enabled", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "ok",
        count: 0,
        credentials: [],
      }),
    );

    await listQaCredentialSets({
      siteUrl: "http://127.0.0.1:3210",
      env: {
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
      },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3210/qa-credentials/v1/admin/list");
  });

  it("rejects unsafe endpoint-prefix overrides", async () => {
    await expect(
      listQaCredentialSets({
        siteUrl: "https://first-schnauzer-821.convex.site",
        endpointPrefix: "//evil.example",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({
      name: "QaCredentialAdminError",
      code: "INVALID_ARGUMENT",
    } satisfies Partial<QaCredentialAdminError>);
  });

  it("surfaces broker error codes for remove", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          status: "error",
          code: "LEASE_ACTIVE",
          message: "Credential is currently leased and cannot be disabled.",
        },
        200,
      ),
    );

    await expect(
      removeQaCredentialSet({
        credentialId: "cred-1",
        siteUrl: "https://first-schnauzer-821.convex.site",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "QaCredentialAdminError",
      code: "LEASE_ACTIVE",
    } satisfies Partial<QaCredentialAdminError>);
  });

  it("lists credentials and forwards includePayload/status filters", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "ok",
        count: 1,
        credentials: [
          {
            credentialId: "cred-2",
            kind: "telegram",
            status: "active",
            createdAtMs: 100,
            updatedAtMs: 100,
            lastLeasedAtMs: 50,
            payload: {
              groupId: "-100123",
              driverToken: "driver",
              sutToken: "sut",
            },
          },
        ],
      }),
    );

    const result = await listQaCredentialSets({
      kind: "telegram",
      status: "active",
      includePayload: true,
      limit: 5,
      siteUrl: "https://first-schnauzer-821.convex.site",
      env: {
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
      },
      fetchImpl,
    });

    expect(result.credentials).toHaveLength(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const bodyText = init?.body;
    expect(typeof bodyText).toBe("string");
    const body = JSON.parse(bodyText as string) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "telegram",
      status: "active",
      includePayload: true,
      limit: 5,
    });
  });

  it("doctors credential broker env without exposing secret values", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "ok",
        count: 1,
        credentials: [
          {
            credentialId: "cred-2",
            kind: "telegram",
            status: "active",
            createdAtMs: 100,
            updatedAtMs: 100,
            lastLeasedAtMs: 50,
          },
        ],
      }),
    );

    const result = await diagnoseQaCredentialBroker({
      siteUrl: "https://first-schnauzer-821.convex.site",
      env: {
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
      },
      fetchImpl,
    });

    expect(result.status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain("ci-secret");
    expect(JSON.stringify(result)).not.toContain("maint-secret");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "broker admin/list",
        status: "pass",
      }),
    );
  });
});
