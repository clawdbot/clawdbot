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

function requireFirstFetchCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const [call] = fetchImpl.mock.calls as unknown[][];
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call;
}

function requireFirstFetchInput(fetchImpl: ReturnType<typeof vi.fn>): RequestInfo | URL {
  const input = requireFirstFetchCall(fetchImpl)[0] as RequestInfo | URL | undefined;
  if (!input) {
    throw new Error("expected fetch input");
  }
  return input;
}

function requireFirstFetchInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit {
  const init = requireFirstFetchCall(fetchImpl)[1];
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected fetch init");
  }
  return init as RequestInit;
}

async function expectQaCredentialAdminError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(QaCredentialAdminError);
  const adminError = error as QaCredentialAdminError;
  expect(adminError.name).toBe("QaCredentialAdminError");
  expect(adminError.code).toBe(code);
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
    expect(requireFirstFetchInput(fetchImpl)).toBe(
      "https://first-schnauzer-821.convex.site/qa-credentials/v1/admin/add",
    );
    const init = requireFirstFetchInit(fetchImpl);
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
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        siteUrl: "https://first-schnauzer-821.convex.site",
        env: {},
        fetchImpl: vi.fn(),
      }),
      "MISSING_MAINTAINER_SECRET",
    );
  });

  it("rejects non-https admin site URLs unless local insecure opt-in is enabled", async () => {
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        siteUrl: "http://qa-cred.example.convex.site",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl: vi.fn(),
      }),
      "INVALID_SITE_URL",
    );
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

    expect(requireFirstFetchInput(fetchImpl)).toBe(
      "http://127.0.0.1:3210/qa-credentials/v1/admin/list",
    );
  });

  it("rejects unsafe endpoint-prefix overrides", async () => {
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        siteUrl: "https://first-schnauzer-821.convex.site",
        endpointPrefix: "//evil.example",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl: vi.fn(),
      }),
      "INVALID_ARGUMENT",
    );
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

    await expectQaCredentialAdminError(
      removeQaCredentialSet({
        credentialId: "cred-1",
        siteUrl: "https://first-schnauzer-821.convex.site",
        env: {
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
        fetchImpl,
      }),
      "LEASE_ACTIVE",
    );
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
    const bodyText = requireFirstFetchInit(fetchImpl).body;
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
    const brokerCheck = result.checks.find((check) => check.name === "broker admin/list");
    expect(brokerCheck?.status).toBe("pass");
  });
});
