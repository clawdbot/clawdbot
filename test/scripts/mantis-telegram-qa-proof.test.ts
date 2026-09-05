import { describe, expect, it } from "vitest";
import { createRequestReceipt, requestIdentitySchema } from "../../scripts/mantis/request-proof.ts";
import { assertRequestWorkflowRef } from "../../scripts/mantis/request-workflow-admission.mjs";
import { removeTelegramQaNetwork } from "../../scripts/mantis/telegram-qa-cleanup.ts";
import {
  isTelegramQaBotApiRequest,
  telegramQaScenario,
} from "../../scripts/mantis/telegram-qa-proof.ts";

it("admits canonical read-only probes without opening arbitrary GET or Bot API methods", () => {
  for (const method of ["getMe", "getWebhookInfo"]) {
    expect(isTelegramQaBotApiRequest("GET", method)).toBe(true);
    expect(isTelegramQaBotApiRequest("POST", method)).toBe(true);
  }
  expect(isTelegramQaBotApiRequest("POST", "sendMessage")).toBe(true);
  for (const method of ["sendMessage", "getUpdates", "deleteWebhook"]) {
    expect(isTelegramQaBotApiRequest("GET", method)).toBe(false);
  }
  for (const method of [
    "getMe?extra=1",
    "getMe/",
    "../getMe",
    "%2e%2e/getMe",
    "http://example.invalid/getMe",
    "//example.invalid/getMe",
    "reset",
    "sendDocument",
    "",
  ]) {
    expect(isTelegramQaBotApiRequest("POST", method)).toBe(false);
  }
  for (const method of [undefined, "HEAD", "PUT", "DELETE"]) {
    expect(isTelegramQaBotApiRequest(method, "getMe")).toBe(false);
  }
});

describe("owned Telegram QA network cleanup", () => {
  it("removes the created network with the supported Podman command", async () => {
    const calls: string[][] = [];
    await removeTelegramQaNetwork(async (args) => {
      calls.push(args);
      return "";
    }, "mantis-qa-fixture");
    expect(calls).toEqual([["network", "rm", "mantis-qa-fixture"]]);
  });
  it("skips only an uncreated network and preserves genuine removal failures", async () => {
    const failure = new Error("network still in use");
    const podman = async () => {
      throw failure;
    };
    await expect(removeTelegramQaNetwork(podman, undefined)).resolves.toBeUndefined();
    await expect(removeTelegramQaNetwork(podman, "mantis-qa-fixture")).rejects.toBe(failure);
  });
});

const identity = requestIdentitySchema.parse({
  request_id: "a".repeat(64),
  repository: { id: "123", full_name: "openclaw/openclaw" },
  pull_request: 42,
  candidate_sha: "b".repeat(40),
  scenario: telegramQaScenario,
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "456", attempt: 1 },
});
const evidence = {
  artifact_id: "789",
  artifact_name: "mantis-request-telegram-456-1",
  sha256: "d".repeat(64),
};
// Synthetic schema fixtures, not proof that a Gateway ran. Canonical QA remains
// the sole assertion interpreter; retained runtime output powers the paired test.
function observations(status: "pass" | "fail" = "pass") {
  return {
    "qa-execution.json": {
      schema: "mantis.telegram-qa-execution.v1",
      request_id: identity.request_id,
      candidate_sha: identity.candidate_sha,
      harness_sha: identity.harness.sha,
      run_id: identity.run.id,
      run_attempt: 1,
      scenario: telegramQaScenario,
      transport: "Crabline",
      live_service: false,
      candidate_quiescent: true,
    },
    "qa-result.json": {
      schema: "mantis.telegram-qa-result.v1",
      scenario: telegramQaScenario,
      status,
      steps: [{ name: "preserves four exact Markdown payloads through Gateway send", status }],
    },
    "qa-observations.json": {
      schema: "mantis.telegram-qa-observations.v1",
      scenario: telegramQaScenario,
      cases: ["all-space-code", "unclosed-link-label", "ipv6-link", "table-code-leading-space"].map(
        (item, index) => ({
          case: item,
          messageId: String(index + 1),
          expectedHtml: "fixture",
          outboundHtml: "fixture",
          acceptedPayloads: [{ text: "fixture", parseMode: status === "pass" ? "HTML" : null }],
        }),
      ),
    },
  };
}
function receipt(files: unknown) {
  return createRequestReceipt(
    identity,
    "completed",
    evidence,
    Object.fromEntries(
      Object.entries(files as Record<string, unknown>).map(([name, value]) => [
        name,
        Buffer.from(JSON.stringify(value)).toString("base64"),
      ]),
    ),
  );
}

describe("canonical Telegram QA evidence contract", () => {
  it.each(["pass", "fail"] as const)(
    "carries the complete canonical %s result with exact file digests",
    (status) => {
      const result = receipt(observations(status));
      expect(result.assertion_outcome).toBe(status);
      expect(result.observations.map(({ id }) => id)).toEqual([
        "qa-execution",
        "qa-result",
        "qa-observations",
      ]);
      expect(
        result.observations.every(
          ({ authority, sha256 }) =>
            authority === "trusted_observer" && /^[a-f0-9]{64}$/.test(sha256 ?? ""),
        ),
      ).toBe(true);
      expect(result.limits.join(" ")).toContain("no Telegram Test Server");
    },
  );
  it.each([
    "wrong-request",
    "live-service",
    "not-quiescent",
    "wrong-transport",
    "wrong-result",
    "missing-case",
    "duplicate-case",
    "extra-key",
    "oversized",
  ])("keeps %s evidence inconclusive", (fault) => {
    const files = observations();
    if (fault === "wrong-request") {
      files["qa-execution.json"].request_id = "e".repeat(64);
    }
    if (fault === "live-service") {
      files["qa-execution.json"].live_service = true;
    }
    if (fault === "not-quiescent") {
      files["qa-execution.json"].candidate_quiescent = false;
    }
    if (fault === "wrong-transport") {
      files["qa-execution.json"].transport = "Telegram Test Server";
    }
    if (fault === "wrong-result") {
      files["qa-result.json"].status = "fail";
    }
    if (fault === "missing-case") {
      files["qa-observations.json"].cases.pop();
    }
    if (fault === "duplicate-case") {
      files["qa-observations.json"].cases[1]!.case = "all-space-code";
    }
    if (fault === "extra-key") {
      Object.assign(files["qa-execution.json"], { readiness: true });
    }
    if (fault === "oversized") {
      files["qa-observations.json"].cases[0]!.outboundHtml = "x".repeat(4097);
    }
    expect(receipt(files).assertion_outcome).toBe("inconclusive");
  });
});

describe("protected stationary workflow admission", () => {
  const sha = "a".repeat(40),
    main = "b".repeat(40);
  it.each([
    "complete",
    "main",
    "unprotected",
    "moved-pin",
    "not-ancestor",
    "moved-main",
    "missing-protection",
    "api-denied",
    "redirect",
  ])("handles %s without auto-trusting main changes", async (fault) => {
    let mainReads = 0;
    const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      if (fault === "api-denied") {
        return new Response(null, { status: 403 });
      }
      if (fault === "redirect") {
        return new Response(null, { status: 302 });
      }
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const route = requestUrl.split("openclaw/openclaw/")[1];
      if (route === "branches/qa-proof") {
        return Response.json({
          name: "qa-proof",
          ...(fault === "missing-protection" ? {} : { protected: fault !== "unprotected" }),
          commit: { sha: fault === "moved-pin" ? main : sha },
        });
      }
      if (route === "branches/main") {
        mainReads++;
        return Response.json({
          name: "main",
          protected: true,
          commit: {
            sha:
              fault === "main"
                ? sha
                : fault === "moved-main" && mainReads > 1
                  ? "c".repeat(40)
                  : main,
          },
        });
      }
      if (route === `compare/${sha}...${main}?per_page=1`) {
        return Response.json({
          status: fault === "not-ancestor" ? "diverged" : "ahead",
          merge_base_commit: { sha },
          base_commit: { sha },
        });
      }
      throw new Error("Unexpected trust route");
    };
    const admission = assertRequestWorkflowRef({
      repository: "openclaw/openclaw",
      ref: fault === "main" ? "refs/heads/main" : "refs/heads/qa-proof",
      sha,
      token: "synthetic-only",
      fetchImpl,
    });
    if (["complete", "main"].includes(fault)) {
      await expect(admission).resolves.toBeUndefined();
    } else {
      await expect(admission).rejects.toThrow();
    }
  });
});
