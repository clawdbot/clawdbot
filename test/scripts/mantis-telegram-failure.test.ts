import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  createRequestReceipt,
  createTelegramFailureDiagnostic,
  requestIdentitySchema,
} from "../../scripts/mantis/request-proof.ts";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";

const identity = requestIdentitySchema.parse({
  request_id: "a".repeat(64),
  plan_sha256: "d".repeat(64),
  repository: { id: "123", full_name: "openclaw/openclaw" },
  pull_request: 42,
  candidate_sha: "b".repeat(40),
  scenario: "telegram-bot-e2e-proof",
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "456", attempt: 1 },
});
const evidence = { artifact_id: "789", artifact_name: "fixture", sha256: "e".repeat(64) };
const encode = (value: unknown) => ({
  "telegram-failure.json": Buffer.from(JSON.stringify(value)).toString("base64"),
});

describe("Telegram failure diagnostics", () => {
  it("binds bounded ordered failure facts to the exact request and never certifies missing captures", async () => {
    const diagnostic = createTelegramFailureDiagnostic(identity, [
      { sequence: 1, category: "scope_rejected" },
    ]);
    for (const execution of ["failed", "completed"] as const) {
      const receipt = createRequestReceipt(identity, execution, evidence, encode(diagnostic));
      expect(receipt.assertion_outcome).toBe("inconclusive");
      expect(receipt.observations).toEqual([]);
      expect(receipt.reason).toContain("1:scope_rejected");
    }
    const authorityReason = "PR is no longer open at the exact same-repository candidate head.";
    for (const value of [diagnostic, { ...diagnostic, raw: "private payload" }]) {
      expect(
        createRequestReceipt(identity, "failed", evidence, encode(value), authorityReason).reason,
      ).toBe(authorityReason);
    }
    for (const changed of [
      { ...diagnostic, candidate_sha: "f".repeat(40) },
      { ...diagnostic, plan_sha256: "f".repeat(64) },
      { ...diagnostic, run: { id: "457", attempt: 1 } },
      { ...diagnostic, request_id: "f".repeat(64) },
      { ...diagnostic, raw: "private payload" },
    ]) {
      const receipt = createRequestReceipt(identity, "failed", evidence, encode(changed));
      expect(receipt.reason).toContain("malformed");
      expect(receipt.assertion_outcome).toBe("inconclusive");
      expect(JSON.stringify(receipt)).not.toContain("private payload");
    }
    for (const entries of [
      [],
      [{ sequence: 2, category: "scope_rejected" }],
      [{ sequence: 1, category: "private payload" }],
      [{ sequence: 1, category: "scope_rejected", message: "private payload" }],
      Array.from({ length: 17 }, (_, i) => ({ sequence: i + 1, category: "scope_rejected" })),
    ]) {
      expect(() => createTelegramFailureDiagnostic(identity, entries)).toThrow();
    }
    expect(createRequestReceipt(identity, "completed", null, undefined).assertion_outcome).toBe(
      "inconclusive",
    );
  });

  it("accepts diagnostic-only archives but rejects mixed, extra and oversized entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tg-diagnostic-"));
    try {
      const diagnostic = createTelegramFailureDiagnostic(identity, [
        { sequence: 1, category: "upstream_failure" },
      ]);
      for (const variant of ["valid", "mixed", "extra", "oversized"]) {
        const zip = new JSZip();
        zip.file(
          "telegram-failure.json",
          variant === "oversized" ? "x".repeat(16385) : JSON.stringify(diagnostic),
        );
        if (variant === "mixed") {
          zip.file("telegram-send.json", "{}");
        }
        if (variant === "extra") {
          zip.file("raw.log", "private payload");
        }
        const archive = path.join(root, `${variant}.zip`),
          output = path.join(root, `${variant}.json`);
        await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
        const run = () =>
          execFileSync(
            "python",
            [
              "-I",
              "-S",
              "scripts/mantis/read-request-archive.py",
              "telegram-evidence",
              archive,
              output,
            ],
            { stdio: "pipe" },
          );
        if (variant === "valid") {
          run();
          expect(
            createRequestReceipt(
              identity,
              "failed",
              evidence,
              JSON.parse(await readFile(output, "utf8")),
            ).reason,
          ).toContain("upstream_failure");
        } else {
          expect(run).toThrow();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "scope_rejected",
    "malformed_request",
    "upstream_failure",
    "network_failure",
    "authority_unavailable",
  ] as const)(
    "records %s through the real ingress without raw error or request data",
    async (expected) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "tg-diagnostic-ingress-"));
      const socket =
        process.platform === "win32"
          ? `\\\\.\\pipe\\mantis-${randomUUID()}`
          : path.join(root, "api.sock");
      const ingress = await startTelegramProofIngress({
        socket,
        alias: "1:fixture",
        sutToken: "private-token",
        testerId: "43",
        providerLog: path.join(root, "provider.ndjson"),
        plan: {
          claim: "fixture",
          actions: [{ type: "send", atMs: 0, text: "hello" }],
          modelReplies: ["reply"],
          settings: { streaming: "off", nativeCommands: false },
          maxDurationMs: 1000,
          expectations: ["reply"],
        },
        lease: {
          assertHealthy() {
            if (expected === "authority_unavailable") {
              throw new Error("private expired lease");
            }
          },
          whenUnhealthy: new Promise<Error>(() => {}),
        },
        fetchImpl: async () => {
          if (expected === "network_failure") {
            throw new Error("private network secret");
          }
          return new Response("private upstream secret", { status: 500 });
        },
      });
      try {
        const request = () =>
          new Promise<number>((resolve, reject) => {
            const req = http.request(
              {
                socketPath: socket,
                path:
                  expected === "scope_rejected"
                    ? "/private-wrong-capability"
                    : "/telegram/bot1:fixture/getMe",
                method: "POST",
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode!));
              },
            );
            req.on("error", reject);
            req.end(expected === "malformed_request" ? "private-not-json" : "{}");
          });
        expect(await request()).toBe(403);
        expect(ingress.getDiagnostics().some((entry) => entry.category === expected)).toBe(true);
        if (expected === "authority_unavailable") {
          expect(ingress.getDiagnostics()).toEqual([
            { sequence: 1, category: "authority_unavailable" },
          ]);
        }
        for (let i = 0; i < 20; i++) {
          await request();
        }
        const diagnostic = createTelegramFailureDiagnostic(identity, ingress.getDiagnostics());
        expect(diagnostic.diagnostics).toHaveLength(16);
        expect(JSON.stringify(diagnostic)).not.toMatch(/private|token|secret/);
        const copy = ingress.getDiagnostics();
        copy.splice(0);
        expect(ingress.getDiagnostics()).toHaveLength(16);
      } finally {
        await ingress.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
