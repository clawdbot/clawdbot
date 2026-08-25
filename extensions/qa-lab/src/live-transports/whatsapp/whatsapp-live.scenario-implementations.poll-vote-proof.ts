import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WhatsAppQaDriverObservedMessage } from "@openclaw/whatsapp/api.js";
import { redactQaGatewayDebugText } from "../../gateway-log-redaction.js";
import type {
  WhatsAppQaMessageScenarioContext,
  WhatsAppQaScenarioImplementation,
} from "./whatsapp-live.contracts.js";
import { callWhatsAppGatewayPoll } from "./whatsapp-live.gateway.js";

const execFileAsync = promisify(execFile);
const POLL_VOTE_PROOF_FIXTURE_PATH =
  "extensions/qa-lab/test-fixtures/whatsapp-poll-vote-proof-plugin";
const POLL_VOTE_PROOF_TIMEOUT_MS = 240_000;
const POLL_VOTE_PROOF_HOOK_TIMEOUT_MS = 30_000;

function digest(value: string | undefined) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
}

function redactText(value: string) {
  return value
    .replace(/\b\d{6,}@(?:s\.whatsapp\.net|lid|g\.us)\b/gu, "<redacted-jid>")
    .replace(/\+?[1-9]\d{6,14}/gu, "<redacted-phone>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<redacted-uuid>")
    .replace(/(bearer|token|secret|password|api[-_]?key)=?\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(
      /((?:"?(?:bearer|token|secret|password|api[-_]?key)"?\s*[:=]\s*)"?)[^"\s,;}]+/giu,
      "$1<redacted>",
    );
}

function assertRedacted(value: string, label: string) {
  if (
    /\+?[1-9]\d{6,14}|\b\d{6,}@(?:s\.whatsapp\.net|lid|g\.us)\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/iu.test(
      value,
    )
  ) {
    throw new Error(`${label} contains an unredacted WhatsApp identifier`);
  }
  if (
    /(?:"?(?:bearer|token|secret|password|api[-_]?key)"?\s*[:=]\s*)(?!<redacted>)/iu.test(value)
  ) {
    throw new Error(`${label} contains an unredacted secret`);
  }
}

async function resolveCurrentHeadSha(context: WhatsAppQaMessageScenarioContext) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: context.repoRoot ?? process.cwd(),
  });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error("unable to resolve the current OpenClaw head SHA");
  }
  return sha;
}

async function waitForHookEvent(params: { hookEventsPath: string; pollMessageId?: string }) {
  const deadline = Date.now() + POLL_VOTE_PROOF_HOOK_TIMEOUT_MS;
  for (;;) {
    const contents = await fs.readFile(params.hookEventsPath, "utf8").catch(() => "");
    const line = contents
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        try {
          return JSON.parse(entry) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((entry) => {
        if (!entry || entry.event !== "poll_vote_received") {
          return false;
        }
        if (!Array.isArray(entry.selectedOptions) || !entry.selectedOptions.includes("alpha")) {
          return false;
        }
        return !params.pollMessageId || entry.pollMessageId === digest(params.pollMessageId);
      });
    if (line) {
      return line;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the poll_vote_received hook fixture output");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function readPollVoteMessageId(message: WhatsAppQaDriverObservedMessage) {
  return message.pollVote?.pollMessageId;
}

async function writePollVoteProofArtifacts(
  context: WhatsAppQaMessageScenarioContext,
  params: {
    artifactDir: string;
    headSha: string;
    hookEvent: Record<string, unknown>;
    pollMessageId?: string;
    pollQuestion: string;
    pollVote: WhatsAppQaDriverObservedMessage;
    pollSendAccepted: boolean;
  },
) {
  const gatewayLog = redactText(
    redactQaGatewayDebugText(context.gateway.logs?.() ?? "gateway logs unavailable"),
  );
  const transcript = [
    `head_sha=${params.headSha}`,
    "gateway_config=isolated_qa_gateway",
    "poll_vote_received_enabled=true",
    `poll_send=accepted message_id=${digest(params.pollMessageId) ?? "missing"}`,
    `awaiting_vote poll_question=${redactText(params.pollQuestion)}`,
    `driver_observation=kind:${params.pollVote.kind} poll_message_id=${digest(readPollVoteMessageId(params.pollVote)) ?? "missing"} selected_options=${params.pollVote.pollVote?.selectedOptions.join(",") ?? "missing"}`,
    `hook_fixture=observed event:${String(params.hookEvent.event ?? "unknown")} selected_options=${Array.isArray(params.hookEvent.selectedOptions) ? params.hookEvent.selectedOptions.join(",") : "missing"}`,
  ]
    .map(redactText)
    .join("\n");
  const proof = {
    schemaVersion: 1,
    status: "pass",
    scenarioId: "whatsapp-poll-vote-hook-proof",
    currentHeadSha: params.headSha,
    assertions: {
      isolatedQaGateway: true,
      pollVoteReceivedEnabled: true,
      gatewayPollSendAccepted: params.pollSendAccepted,
      driverPollVoteObserved: params.pollVote.kind === "poll_vote",
      hookFixtureOutputObserved: params.hookEvent.event === "poll_vote_received",
    },
    redactedIdentifiers: {
      target: digest(context.gatewayTarget),
      pollMessageId: digest(params.pollMessageId),
      votePollMessageId: digest(readPollVoteMessageId(params.pollVote)),
    },
    artifacts: {
      awaitingVote: "awaiting-vote.json",
      transcript: "transcript.txt",
      gatewayLog: "gateway-log.txt",
      hookEvents: "hook-events.jsonl",
    },
  };
  const proofJson = `${JSON.stringify(proof, null, 2)}\n`;
  const proofMarkdown = [
    "# WhatsApp poll-vote hook proof",
    "",
    `- Current head: \`${params.headSha}\``,
    "- Gateway: isolated QA child gateway",
    "- Poll send: accepted through Gateway `poll` RPC",
    "- Vote: observed by the dedicated WhatsApp driver as `poll_vote`",
    "- Hook: `poll_vote_received` fixture output observed",
    "- Identifiers: redacted; hashes are local correlation-only values",
    "",
    "Files in this bundle are deterministic, redacted evidence for the current head.",
    "",
  ].join("\n");
  assertRedacted(transcript, "transcript");
  assertRedacted(gatewayLog, "gateway log");
  const hookEvents = await fs.readFile(path.join(params.artifactDir, "hook-events.jsonl"), "utf8");
  assertRedacted(hookEvents, "hook fixture output");
  await Promise.all([
    fs.writeFile(path.join(params.artifactDir, "proof.json"), proofJson, "utf8"),
    fs.writeFile(path.join(params.artifactDir, "proof.md"), proofMarkdown, "utf8"),
    fs.writeFile(path.join(params.artifactDir, "transcript.txt"), `${transcript}\n`, "utf8"),
    fs.writeFile(path.join(params.artifactDir, "gateway-log.txt"), `${gatewayLog}\n`, "utf8"),
  ]);
  return proof;
}

async function runWhatsAppPollVoteHookProof(
  context: WhatsAppQaMessageScenarioContext,
  question: string,
) {
  if (!context.proofOutputDir) {
    throw new Error("WhatsApp poll-vote proof requires the QA output directory");
  }
  const artifactDir = path.join(context.proofOutputDir, "whatsapp-poll-vote-hook-proof");
  await fs.rm(artifactDir, { force: true, recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  const headSha = await resolveCurrentHeadSha(context);
  const pollStartedAt = new Date();
  const pollSendResult = await callWhatsAppGatewayPoll(context, {
    label: "poll-vote-proof",
    maxSelections: 1,
    options: ["alpha", "beta"],
    question,
  });
  const pollMessageId =
    typeof pollSendResult === "object" && pollSendResult !== null && "messageId" in pollSendResult
      ? typeof pollSendResult.messageId === "string"
        ? pollSendResult.messageId
        : undefined
      : undefined;
  if (!pollMessageId) {
    throw new Error("Gateway poll proof requires an accepted poll messageId");
  }
  const awaitingVote = {
    schemaVersion: 1,
    state: "awaiting_vote",
    scenarioId: "whatsapp-poll-vote-hook-proof",
    currentHeadSha: headSha,
    poll: {
      question,
      options: ["alpha", "beta"],
      maxSelections: 1,
      acceptedByGateway: true,
      messageIdHash: digest(pollMessageId),
    },
    nextAction: "Vote for alpha in the isolated QA conversation, then let the runner continue.",
  };
  await fs.writeFile(
    path.join(artifactDir, "awaiting-vote.json"),
    `${JSON.stringify(awaitingVote, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`WHATSAPP_QA_AWAITING_VOTE ${JSON.stringify(awaitingVote)}\n`);
  const pollVote = await context.driver.waitForMessage({
    observedAfter: pollStartedAt,
    timeoutMs: POLL_VOTE_PROOF_TIMEOUT_MS,
    match: (message) =>
      message.kind === "poll_vote" &&
      message.pollVote?.selectedOptions.includes("alpha") === true &&
      (!pollMessageId || message.pollVote.pollMessageId === pollMessageId),
  });
  context.recordObservedMessage(pollVote);
  const hookEvent = await waitForHookEvent({
    hookEventsPath: path.join(artifactDir, "hook-events.jsonl"),
    pollMessageId,
  });
  await writePollVoteProofArtifacts(context, {
    artifactDir,
    headSha,
    hookEvent,
    pollMessageId,
    pollQuestion: question,
    pollSendAccepted: true,
    pollVote,
  });
  return `poll accepted, vote observed, and poll_vote_received hook output captured in ${path.relative(context.proofOutputDir, artifactDir)}`;
}

export const whatsappQaPollVoteHookProofScenario: WhatsAppQaScenarioImplementation = {
  posture: "direct-gateway",
  configOverrides: {
    pollVoteHookProof: {
      fixturePath: POLL_VOTE_PROOF_FIXTURE_PATH,
    },
  },
  buildRun: () => {
    const token = `WHATSAPP_QA_POLL_VOTE_HOOK_${randomUUID().slice(0, 8).toUpperCase()}`;
    const question = `${token} choose one`;
    return {
      afterReply: async (_reply, context) => await runWhatsAppPollVoteHookProof(context, question),
      configMode: "allowlist",
      expectReply: true,
      input: `Reply with only this exact marker before the poll-vote hook proof: ${token}`,
      matchText: token,
      target: "dm",
    };
  },
};
