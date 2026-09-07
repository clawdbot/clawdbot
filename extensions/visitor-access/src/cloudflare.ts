import { z } from "zod";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";

const policyReferenceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value !== "." && value !== ".."),
  name: z.string(),
});
const emailRuleSchema = z.strictObject({
  email: z.strictObject({ email: z.email().max(254) }),
});
const managedPolicySchema = policyReferenceSchema
  .extend({
    decision: z.literal("allow"),
    include: z.array(emailRuleSchema).max(10_000),
    exclude: z.array(z.unknown()).max(0).optional(),
    require: z.array(z.unknown()).max(0).optional(),
  })
  .passthrough();
const responseSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
  result_info: z
    .object({
      total_pages: z.number().int().nonnegative().optional(),
      per_page: z.number().int().positive().optional(),
    })
    .optional(),
});

type ManagedPolicy = z.infer<typeof managedPolicySchema>;

export class VisitorPolicyClient {
  private readonly policiesUrl: string;

  constructor(
    private readonly config: VisitorAccessConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {
    this.policiesUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/access/apps/${encodeURIComponent(config.appId)}/policies`;
  }

  async read(): Promise<{ id: string; emails: string[] } | undefined> {
    const policy = await this.readPolicy();
    return policy ? { id: policy.id, emails: this.policyEmails(policy) } : undefined;
  }

  async update(
    change: (emails: readonly string[]) => string[] | Promise<string[]>,
  ): Promise<string[]> {
    // Every mutation starts from Cloudflare, preserving dashboard edits made since
    // the previous tool call. The service serializes its own mutations separately.
    const policy = await this.readPolicy();
    const current = policy ? this.policyEmails(policy) : [];
    if (this.signal?.aborted) {
      throw new VisitorAccessError("Visitor access is stopping; retry after the gateway starts.");
    }
    const emails = [...new Set(await change(current))];
    if (emails.length === current.length && emails.every((email) => current.includes(email))) {
      return emails;
    }
    if (policy && emails.length === 0) {
      await this.request(`${this.policiesUrl}/${encodeURIComponent(policy.id)}`, "DELETE");
      return emails;
    }

    const payload: Record<string, unknown> = { ...policy };
    // Retain the policy's restrictions and precedence; only these response-only
    // fields are omitted. Never reconstruct other app policies or their ordering.
    for (const key of ["id", "account_id", "created_at", "updated_at"]) {
      delete payload[key];
    }
    payload.name = this.config.policyName;
    payload.decision = "allow";
    payload.include = emails.map((email) => ({ email: { email } }));
    const url = policy ? `${this.policiesUrl}/${encodeURIComponent(policy.id)}` : this.policiesUrl;
    await this.request(url, policy ? "PUT" : "POST", payload);
    return emails;
  }

  private policyEmails(policy: ManagedPolicy): string[] {
    return [...new Set(policy.include.map((rule) => rule.email.email.toLowerCase()))];
  }

  private async readPolicy(): Promise<ManagedPolicy | undefined> {
    let reference: z.infer<typeof policyReferenceSchema> | undefined;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(`${this.policiesUrl}?page=${page}&per_page=100`, "GET");
      const policies = z.array(policyReferenceSchema).max(100).safeParse(response.result);
      if (!policies.success) {
        throw new VisitorAccessError(
          "Cloudflare returned an invalid policy list; inspect the Access application.",
        );
      }
      for (const policy of policies.data) {
        if (policy.name !== this.config.policyName) {
          continue;
        }
        if (reference) {
          throw new VisitorAccessError(
            "Multiple Access policies have the configured visitor policy name; make the name unique before retrying.",
          );
        }
        reference = policy;
      }
      const totalPages = response.result_info?.total_pages;
      const pageSize = response.result_info?.per_page ?? 100;
      const complete =
        totalPages === undefined ? policies.data.length < pageSize : page >= totalPages;
      if (complete) {
        if (!reference) {
          return undefined;
        }
        // Fetch the selected policy after discovery so its identity and include
        // rules are validated together immediately before the change callback.
        const detail = await this.request(
          `${this.policiesUrl}/${encodeURIComponent(reference.id)}`,
          "GET",
        );
        const parsed = managedPolicySchema.safeParse(detail.result);
        if (
          !parsed.success ||
          parsed.data.id !== reference.id ||
          parsed.data.name !== this.config.policyName
        ) {
          throw new VisitorAccessError(
            "The visitor policy changed or is not an email-only allow policy. Inspect its name, decision, include, require, and exclude rules before retrying.",
          );
        }
        return parsed.data;
      }
    }
    throw new VisitorAccessError(
      "The Access application has too many policies to inspect safely; reduce its policy count before retrying.",
    );
  }

  private async request(url: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown) {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new VisitorAccessError(
        "Cloudflare request failed; check connectivity and retry. Policy state may need reconciliation.",
      );
    }
    if (!response.ok) {
      throw new VisitorAccessError(
        `Cloudflare request failed (HTTP ${response.status}); check the token's Access policy permissions and retry.`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new VisitorAccessError(
        "Cloudflare returned an unreadable response; retry and inspect the visitor policy.",
      );
    }
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success) {
      throw new VisitorAccessError(
        "Cloudflare did not confirm the request; inspect the visitor policy before retrying.",
      );
    }
    return parsed.data;
  }
}
