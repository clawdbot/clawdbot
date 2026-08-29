import { describe, expect, it, vi } from "vitest";
import { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";

const config: VisitorAccessConfig = {
  accountId: "account-id",
  appId: "app-id",
  apiToken: "test-token-never-echo",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const collectionUrl =
  "https://api.cloudflare.com/client/v4/accounts/account-id/access/apps/app-id/policies";

function namedPolicy(emails = ["first@example.com"]) {
  return {
    id: "visitor-policy",
    name: config.policyName,
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
  };
}

function cloudflareResponse(result: unknown, resultInfo?: unknown) {
  return Response.json({ success: true, result, result_info: resultInfo });
}

function fetchSequence(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(response);
  }
  return fetcher;
}

function requestBody(fetcher: ReturnType<typeof fetchSequence>, index: number) {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as unknown;
}

describe("VisitorPolicyClient", () => {
  it("creates only the named app policy when absent, leaving other policies untouched", async () => {
    const maintainers = { id: "maintainers", name: "GitHub organization", decision: "allow" };
    const fetcher = fetchSequence(
      cloudflareResponse([maintainers]),
      cloudflareResponse(namedPolicy()),
    );
    const client = new VisitorPolicyClient(config, fetcher);

    await expect(client.update(() => ["first@example.com"])).resolves.toEqual([
      "first@example.com",
    ]);

    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      [`${collectionUrl}?page=1&per_page=100`, "GET"],
      [collectionUrl, "POST"],
    ]);
    expect(requestBody(fetcher, 1)).toEqual({
      name: config.policyName,
      decision: "allow",
      include: [{ email: { email: "first@example.com" } }],
    });
  });

  it("rereads the named policy and preserves dashboard grants and restrictions on update", async () => {
    const original = namedPolicy();
    const updated = {
      ...namedPolicy(["first@example.com", "manual@example.com"]),
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ["approver@example.com"] }],
      mfa_config: { mfa_disabled: false },
      created_at: "2026-08-28T00:00:00Z",
    };
    const fetcher = fetchSequence(
      cloudflareResponse([original]),
      cloudflareResponse(original),
      cloudflareResponse([updated]),
      cloudflareResponse(updated),
      cloudflareResponse(updated),
    );
    const client = new VisitorPolicyClient(config, fetcher);
    await expect(client.read()).resolves.toEqual({
      id: original.id,
      emails: ["first@example.com"],
    });

    await expect(client.update((emails) => [...emails, "next@example.com"])).resolves.toEqual([
      "first@example.com",
      "manual@example.com",
      "next@example.com",
    ]);

    expect(requestBody(fetcher, 4)).toEqual({
      name: config.policyName,
      decision: "allow",
      include: ["first@example.com", "manual@example.com", "next@example.com"].map((email) => ({
        email: { email },
      })),
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: updated.approval_groups,
      mfa_config: updated.mfa_config,
    });
    expect(fetcher.mock.calls[4]?.[0]).toBe(`${collectionUrl}/${original.id}`);
    expect(fetcher.mock.calls[4]?.[1]?.method).toBe("PUT");
  });

  it.each([
    ["deny decision", { decision: "deny" }],
    ["non-email includes", { include: [{ everyone: {} }] }],
    ["mixed email rules", { include: [{ email: { email: "first@example.com" }, everyone: {} }] }],
    ["required restrictions", { require: [{ email_domain: { domain: "example.com" } }] }],
    ["excluded identities", { exclude: [{ email: { email: "excluded@example.com" } }] }],
    ["renamed policy", { name: "GitHub organization" }],
    ["replaced policy", { id: "other-policy" }],
  ])("refuses %s before running a change or writing Cloudflare", async (_name, override) => {
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      cloudflareResponse([policy]),
      cloudflareResponse({ ...policy, ...override }),
    );
    const change = vi.fn(() => ["next@example.com"]);
    await expect(new VisitorPolicyClient(config, fetcher).update(change)).rejects.toBeInstanceOf(
      VisitorAccessError,
    );
    expect(change).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("finds a policy on later pages and refuses duplicate configured names across pages", async () => {
    const other = { id: "other", name: "Maintainers" };
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      cloudflareResponse([other], { total_pages: 2 }),
      cloudflareResponse([policy], { total_pages: 2 }),
      cloudflareResponse(policy),
    );
    await expect(new VisitorPolicyClient(config, fetcher).read()).resolves.toEqual({
      id: policy.id,
      emails: ["first@example.com"],
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${collectionUrl}?page=2&per_page=100`);

    const duplicates = fetchSequence(
      cloudflareResponse([policy], { total_pages: 2 }),
      cloudflareResponse([{ ...policy, id: "duplicate" }], { total_pages: 2 }),
    );
    await expect(
      new VisitorPolicyClient(config, duplicates).update(() => []),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(duplicates.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("deletes only the named policy when its final email is removed", async () => {
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      cloudflareResponse([policy]),
      cloudflareResponse(policy),
      cloudflareResponse({ id: policy.id }),
    );
    await expect(new VisitorPolicyClient(config, fetcher).update(() => [])).resolves.toEqual([]);
    expect(fetcher.mock.calls[2]?.[0]).toBe(`${collectionUrl}/${policy.id}`);
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  it.each([{ emails: [] }, { emails: ["FIRST@example.com"] }])(
    "avoids a write when normalized membership is unchanged: $emails",
    async ({ emails }) => {
      const policy = namedPolicy(emails);
      const fetcher = emails.length
        ? fetchSequence(cloudflareResponse([policy]), cloudflareResponse(policy))
        : fetchSequence(cloudflareResponse([]));
      const change = vi.fn(async (current: readonly string[]) => [...current]);
      await expect(new VisitorPolicyClient(config, fetcher).update(change)).resolves.toEqual(
        emails.map((email) => email.toLowerCase()),
      );
      expect(change).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    },
  );

  it("does not mutate Cloudflare when the durable change callback fails", async () => {
    const fetcher = fetchSequence(cloudflareResponse([]));
    await expect(
      new VisitorPolicyClient(config, fetcher).update(async () => {
        throw new VisitorAccessError("The grant store is unavailable");
      }),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["network", "http", "api", "json"])(
    "never exposes token-bearing %s failures",
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>();
      if (mode === "network") {
        fetcher.mockRejectedValueOnce(new Error(config.apiToken));
      } else if (mode === "http") {
        fetcher.mockResolvedValueOnce(new Response(config.apiToken, { status: 403 }));
      } else if (mode === "api") {
        fetcher.mockResolvedValueOnce(
          Response.json({ success: false, errors: [{ message: config.apiToken }] }),
        );
      } else {
        fetcher.mockResolvedValueOnce(new Response(config.apiToken));
      }
      const error = await new VisitorPolicyClient(config, fetcher)
        .read()
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(VisitorAccessError);
      expect(String(error)).not.toContain(config.apiToken);
      const options = fetcher.mock.calls[0]?.[1];
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("fences an obsolete service before the durable callback runs", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      abort.abort();
      return cloudflareResponse([]);
    });
    const change = vi.fn(() => ["next@example.com"]);
    await expect(
      new VisitorPolicyClient(config, fetcher, abort.signal).update(change),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(change).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
