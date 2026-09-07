import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  createRequestReceipt,
  requestEvidenceDigest,
  requestIdentitySchema,
  requestReceiptSchema,
} from "../../scripts/mantis/request-proof.ts";

const identity = requestIdentitySchema.parse({
  request_id: "a".repeat(64),
  repository: { id: "123", full_name: "openclaw/openclaw" },
  pull_request: 42,
  candidate_sha: "b".repeat(40),
  scenario: "web-ui-chat-proof",
  workflow: { path: ".github/workflows/mantis-web-ui-chat-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "456", attempt: 1 },
});
const evidence = {
  artifact_id: "789",
  artifact_name: "mantis-request-web-ui-456-1",
  sha256: "d".repeat(64),
};
function observations(wrongMessage = false) {
  const expected = {
    deliver: false,
    message: "Mantis request 00000000-0000-4000-8000-000000000000",
    sessionKey: "agent:main:main",
  };
  const reply = "Mantis reply 00000000-0000-4000-8000-000000000000";
  const files: Record<string, Buffer> = {
    "chat-send.json": Buffer.from(
      JSON.stringify({
        expected,
        request_count: 1,
        actual: {
          ...expected,
          message: wrongMessage ? "wrong" : expected.message,
          idempotencyKey: "observed-key",
        },
      }),
    ),
    "final-reply.json": Buffer.from(JSON.stringify({ expected: reply, actual: reply })),
    "final-reply.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  files["observer.json"] = Buffer.from(
    JSON.stringify({
      schema: "mantis.web-ui-observer.v1",
      inventory: Object.entries(files).map(([name, bytes]) => ({
        path: name,
        sha256: requestEvidenceDigest(bytes),
      })),
    }),
  );
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, bytes.toString("base64")]),
  );
}

describe("request proof finalization", () => {
  it.each([
    [false, "pass"],
    [true, "fail"],
  ] as const)(
    "derives assertions from complete independent observations (wrong=%s)",
    (wrong, outcome) => {
      const receipt = createRequestReceipt(identity, "completed", evidence, observations(wrong));
      expect(receipt.assertion_outcome).toBe(outcome);
      expect(receipt).toMatchObject({
        ...identity,
        evidence,
        observations: [
          { id: "chat-send", authority: "trusted_observer", availability: "present" },
          { id: "final-reply", authority: "trusted_observer", availability: "present" },
          { id: "final-screenshot", authority: "trusted_observer", availability: "present" },
        ],
      });
    },
  );
  it.each(["failed", "cancelled", "timed_out", "skipped"] as const)(
    "does not turn %s into product evidence",
    (outcome) => {
      expect(
        createRequestReceipt(identity, outcome, evidence, observations()).assertion_outcome,
      ).toBe("inconclusive");
    },
  );
  it("retains missing evidence and stale-head reasons without inventing a digest or pass", () => {
    expect(createRequestReceipt(identity, "completed", null, observations())).toMatchObject({
      assertion_outcome: "inconclusive",
      evidence: null,
      observations: [],
      reason: expect.any(String),
    });
    expect(
      createRequestReceipt(identity, "completed", evidence, observations(), "PR head changed"),
    ).toMatchObject({
      assertion_outcome: "inconclusive",
      limits: expect.arrayContaining(["PR head changed"]),
    });
  });
  it.each(["missing", "changed", "duplicate", "unknown", "oversized"])(
    "rejects %s observation inventory",
    (fault) => {
      const files = observations();
      if (fault === "missing") {
        delete files["final-reply.png"];
      }
      if (fault === "changed") {
        files["chat-send.json"] = Buffer.from("{}").toString("base64");
      }
      if (fault === "duplicate") {
        const rawManifest = files["observer.json"];
        if (!rawManifest) {
          throw new Error("Fixture manifest missing");
        }
        const manifest = JSON.parse(Buffer.from(rawManifest, "base64").toString());
        manifest.inventory[1] = manifest.inventory[0];
        files["observer.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
      }
      if (fault === "unknown") {
        files["receipt.json"] = Buffer.from("pass").toString("base64");
      }
      if (fault === "oversized") {
        files["observer.json"] = Buffer.alloc(65537).toString("base64");
      }
      expect(createRequestReceipt(identity, "completed", evidence, files).assertion_outcome).toBe(
        "inconclusive",
      );
    },
  );
  it("rejects unbound identity and candidate-supplied authority escalation", () => {
    expect(() =>
      requestIdentitySchema.parse({ ...identity, request_id: "A".repeat(64) }),
    ).toThrow();
    expect(() => requestIdentitySchema.parse({ ...identity, readiness: true })).toThrow();
    expect(() =>
      requestIdentitySchema.parse({ ...identity, run: { ...identity.run, attempt: 2 } }),
    ).toThrow();
    expect(() =>
      requestIdentitySchema.parse({ ...identity, harness: { sha: "f".repeat(40) } }),
    ).toThrow();
    const receipt = createRequestReceipt(identity, "completed", evidence, observations());
    const first = receipt.observations[0];
    if (!first) {
      throw new Error("Fixture observation missing");
    }
    first.authority = "candidate_reported";
    expect(() => requestReceiptSchema.parse(receipt)).toThrow();
    first.authority = "trusted_observer";
    first.source_path = "../receipt.json";
    expect(() => requestReceiptSchema.parse(receipt)).toThrow();
  });
  it("does not pass duplicate Web UI sends", () => {
    const files = observations();
    const send = JSON.parse(Buffer.from(files["chat-send.json"]!, "base64").toString("utf8"));
    send.request_count = 2;
    const bytes = Buffer.from(JSON.stringify(send));
    files["chat-send.json"] = bytes.toString("base64");
    const manifest = JSON.parse(Buffer.from(files["observer.json"]!, "base64").toString("utf8"));
    manifest.inventory.find((item: { path: string }) => item.path === "chat-send.json").sha256 =
      requestEvidenceDigest(bytes);
    files["observer.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
    expect(createRequestReceipt(identity, "completed", evidence, files).assertion_outcome).toBe(
      "inconclusive",
    );
  });
});

describe("consumer dispatch contract", () => {
  it.each([
    ["mantis-web-ui-chat-proof.yml", "Mantis request [{0}]"],
    ["mantis-telegram-bot-e2e-proof.yml", "Mantis Telegram request [{0}]"],
  ])(
    "keeps %s request IDs discoverable after a lost dispatch acknowledgement",
    (workflow, title) => {
      const source = readFileSync(path.resolve(".github/workflows", workflow), "utf8");
      expect(source).toContain(`format('${title}', inputs.request_id)`);
      expect(source).toMatch(/context.actor [!=]== "clawsweeper\[bot\]"/);
    },
  );
});

describe("archive boundary", () => {
  const parser = path.resolve("scripts/mantis/read-request-archive.py");
  it.each(["complete", "traversal", "symlink", "missing", "oversized", "duplicate", "nul-path"])(
    "handles %s ZIP without unsafe extraction",
    async (fault) => {
      const temp = mkdtempSync(path.join(os.tmpdir(), "mantis-archive-"));
      try {
        const zip = new JSZip();
        for (const [name, value] of Object.entries(observations())) {
          zip.file(name, Buffer.from(value, "base64"));
        }
        if (fault === "traversal") {
          zip.file("../escape", "bad");
        }
        if (fault === "symlink") {
          zip.file("final-reply.png", "../escape", { unixPermissions: 0o120777 });
        }
        if (fault === "missing") {
          zip.remove("final-reply.png");
        }
        if (fault === "nul-path") {
          const manifest = await zip.file("observer.json")?.async("nodebuffer");
          if (!manifest) {
            throw new Error("Fixture manifest missing");
          }
          zip.remove("observer.json");
          zip.file("observer.json\0unused", manifest);
        }
        if (fault === "oversized") {
          zip.file("observer.json", Buffer.alloc(65537));
        }
        const archive = path.join(temp, "evidence.zip");
        const output = path.join(temp, "files.json");
        writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
        if (fault === "duplicate") {
          execFileSync(
            "python3",
            [
              "-I",
              "-S",
              "-c",
              "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'a'); z.writestr('observer.json', '{}'); z.close()",
              archive,
            ],
            { stdio: "pipe" },
          );
        }
        const parse = () =>
          execFileSync("python3", ["-I", "-S", parser, "evidence", archive, output], {
            stdio: "pipe",
          });
        if (fault === "complete") {
          parse();
          const receipt = createRequestReceipt(
            identity,
            "completed",
            evidence,
            JSON.parse(readFileSync(output, "utf8")),
          );
          expect(receipt.assertion_outcome).toBe("pass");
        } else {
          expect(parse).toThrow();
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});

describe("trusted finalizer CLI", () => {
  const finalizer = path.resolve("scripts/mantis/finalize-request-proof.mts");
  const parser = path.resolve("scripts/mantis/read-request-archive.py");
  it.each([
    "complete",
    "qualified-path",
    "wrong-path-ref",
    "redirect",
    "digest-mismatch",
    "wrong-run",
    "stale-head",
    "stale-head-and-digest-mismatch",
    "wrong-attempt",
    "timed-out",
    "wrong-title",
    "wrong-job-run",
    "incomplete-jobs",
    "missing-digest",
    "wrong-size",
  ])("binds authoritative API metadata and actual ZIP bytes (%s)", async (fault) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "mantis-finalizer-"));
    try {
      const zip = new JSZip();
      for (const [name, value] of Object.entries(observations())) {
        zip.file(name, Buffer.from(value, "base64"));
      }
      const archive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
      const archivePath = path.join(temp, "fixture.zip");
      writeFileSync(archivePath, archive);
      mkdirSync(path.join(temp, "scripts/mantis"), { recursive: true });
      copyFileSync(parser, path.join(temp, "scripts/mantis/read-request-archive.py"));
      const run = {
        id: 456,
        run_attempt: fault === "wrong-attempt" ? 2 : 1,
        event: "workflow_dispatch",
        head_sha: identity.workflow.sha,
        path:
          fault === "qualified-path"
            ? identity.workflow.path + "@mantis-proof-v1"
            : fault === "wrong-path-ref"
              ? identity.workflow.path + "@other-ref"
              : identity.workflow.path,
        display_title:
          fault === "wrong-title" ? "other request" : `Mantis request [${identity.request_id}]`,
        repository: { id: 123 },
        head_repository: { id: 123 },
      };
      const artifact = {
        id: 789,
        name: evidence.artifact_name,
        expired: false,
        size_in_bytes: archive.length + (fault === "wrong-size" ? 1 : 0),
        digest:
          fault === "missing-digest"
            ? null
            : "sha256:" +
              (fault.includes("digest-mismatch") ? "e".repeat(64) : requestEvidenceDigest(archive)),
        workflow_run: {
          id: fault === "wrong-run" ? 999 : 456,
          repository_id: 123,
          head_repository_id: 123,
          head_sha: identity.workflow.sha,
        },
      };
      const pr = {
        state: "open",
        head: {
          sha: fault.startsWith("stale-head") ? "f".repeat(40) : identity.candidate_sha,
          repo: { id: 123 },
        },
      };
      const mockPath = path.join(temp, "mock-api.mjs");
      const routes = {
        "https://api.github.com/repos/openclaw/openclaw/actions/runs/456/attempts/1": run,
        "https://api.github.com/repos/openclaw/openclaw/actions/runs/456/attempts/1/jobs?per_page=100":
          {
            total_count: fault === "incomplete-jobs" ? 2 : 1,
            jobs: [
              {
                name: "Run request-bound web chat proof",
                run_id: fault === "wrong-job-run" ? 999 : 456,
                head_sha: identity.workflow.sha,
                status: "completed",
                conclusion: fault === "timed-out" ? "timed_out" : "success",
              },
            ],
          },
        "https://api.github.com/repos/openclaw/openclaw/pulls/42": pr,
        "https://api.github.com/repos/openclaw/openclaw/actions/runs/456/artifacts?per_page=100&name=mantis-request-web-ui-456-1":
          { total_count: 1, artifacts: [artifact] },
      };
      writeFileSync(
        mockPath,
        [
          'import { readFileSync } from "node:fs";',
          "const routes = " + JSON.stringify(routes) + ";",
          "const archive = readFileSync(" + JSON.stringify(archivePath) + ");",
          "globalThis.fetch = async (url, options) => {",
          "  const key = String(url);",
          "  if (Object.hasOwn(routes, key)) return Response.json(routes[key]);",
          '  if (key === "https://api.github.com/repos/openclaw/openclaw/actions/artifacts/789/zip") {',
          fault === "redirect"
            ? 'return new Response(null, { status: 302, headers: { location: "https://fixture.blob.core.windows.net/evidence" } });'
            : "return new Response(archive);",
          "  }",
          '  if (key === "https://fixture.blob.core.windows.net/evidence") { if (options.headers?.Authorization) throw new Error("Authorization leaked"); return new Response(archive); }',
          '  throw new Error("Unexpected network request");',
          "};",
        ].join("\n"),
      );
      const invoke = () =>
        execFileSync(process.execPath, ["--import", pathToFileURL(mockPath).href, finalizer], {
          cwd: temp,
          stdio: "pipe",
          timeout: 15_000,
          env: {
            PATH: process.env.PATH,
            GH_TOKEN: "test-only-placeholder",
            REQUEST_ID: identity.request_id,
            TARGET_PR: "42",
            CANDIDATE_SHA: identity.candidate_sha,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_REPOSITORY_ID: "123",
            GITHUB_WORKFLOW_SHA: identity.workflow.sha,
            GITHUB_REF: "refs/heads/mantis-proof-v1",
            GITHUB_RUN_ID: "456",
            GITHUB_RUN_ATTEMPT: "1",
          },
        });
      if (
        [
          "wrong-attempt",
          "wrong-title",
          "wrong-job-run",
          "incomplete-jobs",
          "wrong-path-ref",
        ].includes(fault)
      ) {
        expect(invoke).toThrow();
        return;
      }
      invoke();
      const receipt = requestReceiptSchema.parse(
        JSON.parse(
          readFileSync(path.join(temp, ".artifacts/mantis-request-finalizer/receipt.json"), "utf8"),
        ),
      );
      expect(receipt.assertion_outcome).toBe(
        ["complete", "redirect", "qualified-path"].includes(fault) ? "pass" : "inconclusive",
      );
      if (["complete", "redirect", "qualified-path"].includes(fault)) {
        expect(receipt.evidence?.sha256).toBe(requestEvidenceDigest(archive));
      }
      if (["digest-mismatch", "wrong-run"].includes(fault)) {
        expect(receipt.evidence).toBeNull();
      }
      if (fault.startsWith("stale-head")) {
        expect(receipt.reason).toBe(
          "PR is no longer open at the exact same-repository candidate head.",
        );
      } else if (fault === "digest-mismatch") {
        expect(receipt.reason).toBe(
          "Evidence archive is unavailable, ambiguous, expired, malformed, unsafe, partial, or does not match its authoritative identity/digest.",
        );
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
