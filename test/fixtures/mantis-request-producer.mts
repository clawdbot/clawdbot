// Cross-repository contract fixture: actual recorder/normalizer and finalizer,
// with synthetic GitHub metadata. No credentials or live Telegram calls.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import {
  requestIdentitySchema,
  requestReceiptSchema,
  requestEvidenceDigest as digest,
  requestProofDefinitions,
} from "../../scripts/mantis/request-proof.ts";
import { normalizeTelegramCapture } from "../../scripts/mantis/telegram-capture.ts";
import { parseTelegramProofPlan } from "../../scripts/mantis/telegram-proof-plan.ts";
import {
  telegramQaExecutionSchema,
  telegramQaResultSchema,
  telegramQaObservationsSchema,
  telegramQaScenario,
} from "../../scripts/mantis/telegram-qa-proof.ts";
import { telegramProofIdentitySchema } from "../../scripts/mantis/telegram-request-proof.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
export async function produceRequestFixture(
  input: unknown,
  outcome: "pass" | "fail",
  observationDirectory?: string,
  proofPlan: unknown = {
    claim: "A selected reply is observed",
    actions: [{ type: "send", atMs: 0, text: "hello" }],
    modelReplies: ["reply"],
    settings: { streaming: "off", nativeCommands: false },
    maxDurationMs: 1000,
    expectations: ["The bot answers reply"],
  },
) {
  const identity = requestIdentitySchema.parse(input);
  const definition = requestProofDefinitions[identity.scenario];
  const temp = mkdtempSync(path.join(os.tmpdir(), "mantis-producer-contract-"));
  try {
    let files: Record<string, Buffer>;
    if (identity.scenario === "telegram-bot-e2e-proof") {
      const telegramIdentity = telegramProofIdentitySchema.parse(identity);
      const plan = parseTelegramProofPlan(JSON.stringify(proofPlan), telegramIdentity.plan_sha256);
      const action = plan.actions[0];
      if (
        plan.actions.length !== 1 ||
        action?.type !== "send" ||
        action.atMs !== 0 ||
        plan.modelReplies.length !== 1 ||
        plan.settings.streaming !== "off"
      ) {
        throw new Error(
          "The offline recorder fixture exercises one immediate send and one non-streaming reply",
        );
      }
      const reply = outcome === "pass" ? plan.modelReplies[0]! : "wrong reply";
      execFileSync(
        "python3",
        [
          path.join(root, "test/fixtures/mantis-telegram-recorder.py"),
          path.join(root, ".agents/skills/telegram-e2e-userbot/scripts/user-record.py"),
          temp,
          action.text,
          reply,
        ],
        { stdio: "pipe", timeout: 10_000 },
      );
      const capture = normalizeTelegramCapture({
        identity: telegramIdentity,
        plan,
        salt: Buffer.alloc(32, 7),
        sutId: 42,
        testerId: 43,
        testDc: true,
        ready: JSON.parse(readFileSync(path.join(temp, "ready.json"), "utf8")),
        summary: JSON.parse(readFileSync(path.join(temp, "summary.json"), "utf8")),
        raw: readFileSync(path.join(temp, "events.ndjson"), "utf8"),
        provider: [{ user_text: action.text, response_text: reply, streaming: false }],
        quiescent: true,
        leaseHealthy: true,
        privateValues: [],
      });
      files = Object.fromEntries(
        Object.entries(capture).map(([name, data]) => [name, Buffer.from(JSON.stringify(data))]),
      );
    } else if (identity.scenario === telegramQaScenario) {
      if (!observationDirectory) {
        throw new Error("Retained actual Gateway QA observer output is required");
      }
      files = Object.fromEntries(
        ["qa-execution.json", "qa-result.json", "qa-observations.json"].map((name) => [
          name,
          readFileSync(path.join(observationDirectory, name)),
        ]),
      );
      const execution = telegramQaExecutionSchema.parse(
        JSON.parse(files["qa-execution.json"]!.toString()),
      );
      const result = telegramQaResultSchema.parse(JSON.parse(files["qa-result.json"]!.toString()));
      telegramQaObservationsSchema.parse(JSON.parse(files["qa-observations.json"]!.toString()));
      if (result.status !== outcome) {
        throw new Error("Retained canonical QA result does not match requested outcome");
      }
      if (execution.candidate_sha !== identity.candidate_sha) {
        throw new Error("Retained QA candidate does not match fixture candidate");
      }
      // Only controlled GitHub request/run metadata is rebound. The exercised
      // candidate, canonical result, and recorded observations are not fabricated.
      files["qa-execution.json"] = Buffer.from(
        JSON.stringify({
          ...execution,
          request_id: identity.request_id,
          harness_sha: identity.harness.sha,
          run_id: identity.run.id,
          run_attempt: identity.run.attempt,
        }),
      );
    } else {
      if (!observationDirectory) {
        throw new Error("Retained real Web UI observer output is required");
      }
      files = Object.fromEntries(
        ["observer.json", "chat-send.json", "final-reply.json", "final-reply.png"].map((name) => [
          name,
          readFileSync(path.join(observationDirectory, name)),
        ]),
      );
      if (outcome === "fail") {
        // Controlled substitution after the real capture proves fail reassessment.
        const send = JSON.parse(files["chat-send.json"]!.toString("utf8"));
        send.actual.message = "wrong message";
        files["chat-send.json"] = Buffer.from(JSON.stringify(send));
        const manifest = JSON.parse(files["observer.json"]!.toString("utf8"));
        manifest.inventory.find(
          (entry: { path: string }) => entry.path === "chat-send.json",
        ).sha256 = digest(files["chat-send.json"]);
        files["observer.json"] = Buffer.from(JSON.stringify(manifest));
      }
    }
    const zip = new JSZip();
    for (const [name, bytes] of Object.entries(files)) {
      zip.file(name, bytes);
    }
    const evidenceArchive = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    const artifact = {
      id: 400,
      name: `${definition.artifact}-${identity.run.id}-1`,
      expired: false,
      size_in_bytes: evidenceArchive.length,
      digest: `sha256:${digest(evidenceArchive)}`,
      workflow_run: {
        id: Number(identity.run.id),
        repository_id: Number(identity.repository.id),
        head_repository_id: Number(identity.repository.id),
        head_sha: identity.workflow.sha,
      },
    };
    const repo = `https://api.github.com/repos/${identity.repository.full_name}`;
    const attempt = `${repo}/actions/runs/${identity.run.id}/attempts/1`;
    const routes = {
      [attempt]: {
        id: Number(identity.run.id),
        run_attempt: 1,
        event: "workflow_dispatch",
        head_sha: identity.workflow.sha,
        path: identity.workflow.path,
        display_title: `${definition.runName} [${identity.request_id}]`,
        repository: { id: Number(identity.repository.id) },
        head_repository: { id: Number(identity.repository.id) },
      },
      [`${attempt}/jobs?per_page=100`]: {
        total_count: 1,
        jobs: [
          {
            name: definition.job,
            status: "completed",
            conclusion: "success",
            run_id: Number(identity.run.id),
            head_sha: identity.workflow.sha,
          },
        ],
      },
      [`${repo}/pulls/${identity.pull_request}`]: {
        state: "open",
        head: { sha: identity.candidate_sha, repo: { id: Number(identity.repository.id) } },
      },
      [`${repo}/actions/runs/${identity.run.id}/artifacts?per_page=100&name=${artifact.name}`]: {
        total_count: 1,
        artifacts: [artifact],
      },
    };
    const mock = path.join(temp, "api.mjs");
    writeFileSync(
      mock,
      `const routes = ${JSON.stringify(routes)};
globalThis.fetch = async (url) => {
  const key = String(url);
  if (Object.hasOwn(routes, key)) return Response.json(routes[key]);
  if (key === ${JSON.stringify(`${repo}/actions/artifacts/400/zip`)}) return new Response(Buffer.from(${JSON.stringify(evidenceArchive.toString("base64"))}, "base64"));
  throw new Error("Unexpected network access in controlled proof");
};\n`,
    );
    mkdirSync(path.join(temp, "scripts/mantis"), { recursive: true });
    copyFileSync(
      path.join(root, "scripts/mantis/read-request-archive.py"),
      path.join(temp, "scripts/mantis/read-request-archive.py"),
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(mock).href,
        path.join(root, "scripts/mantis/finalize-request-proof.mts"),
        identity.scenario,
      ],
      {
        cwd: temp,
        stdio: "pipe",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          GH_TOKEN: "controlled-fixture-only",
          REQUEST_ID: identity.request_id,
          ...(identity.plan_sha256 ? { PLAN_SHA256: identity.plan_sha256 } : {}),
          TARGET_PR: String(identity.pull_request),
          CANDIDATE_SHA: identity.candidate_sha,
          GITHUB_REPOSITORY: identity.repository.full_name,
          GITHUB_REPOSITORY_ID: identity.repository.id,
          GITHUB_WORKFLOW_SHA: identity.workflow.sha,
          GITHUB_RUN_ID: identity.run.id,
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
    );
    const receipt = requestReceiptSchema.parse(
      JSON.parse(
        readFileSync(path.join(temp, ".artifacts/mantis-request-finalizer/receipt.json"), "utf8"),
      ),
    );
    const expectedOutcome =
      identity.scenario === "telegram-bot-e2e-proof" ? "inconclusive" : outcome;
    if (receipt.assertion_outcome !== expectedOutcome) {
      throw new Error("Producer did not finalize the expected controlled outcome");
    }
    if (identity.scenario === telegramQaScenario) {
      receipt.limits.push(
        "Controlled cross-repository fixture: request, harness and run metadata are remapped; candidate SHA and retained canonical result/observation bytes are unchanged.",
      );
      requestReceiptSchema.parse(receipt);
    }
    return { receipt, evidenceArchive };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
