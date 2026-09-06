import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeTelegramCapture } from "../../scripts/mantis/telegram-capture.ts";
import type { TelegramProofPlan } from "../../scripts/mantis/telegram-proof-plan.ts";
import {
  verifyTelegramProofFiles,
  telegramProofIdentitySchema,
} from "../../scripts/mantis/telegram-request-proof.ts";

const plan: TelegramProofPlan = {
  claim: "Selected reply",
  actions: [{ type: "send", atMs: 0, text: "hello" }],
  modelReplies: ["reply"],
  settings: { streaming: "off", nativeCommands: false },
  maxDurationMs: 1000,
  expectations: ["A reply is present"],
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const identity = telegramProofIdentitySchema.parse({
  request_id: "a".repeat(64),
  plan_sha256: createHash("sha256").update(canonical(plan)).digest("hex"),
  repository: { id: "1", full_name: "openclaw/openclaw" },
  pull_request: 1,
  candidate_sha: "b".repeat(40),
  scenario: "telegram-bot-e2e-proof",
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "2", attempt: 1 },
});
for (const reply of ["reply", "wrong reply"]) {
  const root = await mkdtemp("/tmp/mantis-capture-");
  try {
    execFileSync("python3", [process.argv[2]!, process.argv[3]!, root, "hello", reply]);
    const input = {
      identity,
      plan,
      salt: Buffer.alloc(32, 1),
      sutId: 42,
      testerId: 43,
      testDc: true,
      ready: JSON.parse(await readFile(path.join(root, "ready.json"), "utf8")),
      summary: JSON.parse(await readFile(path.join(root, "summary.json"), "utf8")),
      raw: await readFile(path.join(root, "events.ndjson"), "utf8"),
      provider: [{ user_text: "hello", response_text: "reply", streaming: false }],
      quiescent: true,
      leaseHealthy: true,
      privateValues: ["private-token"],
    };
    const facts = normalizeTelegramCapture(input);
    assert(facts["telegram-reply.json"].events.some((event) => event.text === reply));
    const encoded = Object.fromEntries(
      Object.entries(facts).map(([k, v]) => [k, Buffer.from(JSON.stringify(v)).toString("base64")]),
    );
    assert.equal(verifyTelegramProofFiles(identity, encoded).assertion_outcome, "inconclusive");
    assert.throws(() => normalizeTelegramCapture({ ...input, quiescent: false }));
    assert.throws(() => normalizeTelegramCapture({ ...input, leaseHealthy: false }));
    assert.throws(() => normalizeTelegramCapture({ ...input, raw: input.raw.repeat(300) }));
    const redacted = normalizeTelegramCapture({
      ...input,
      raw: input.raw.replaceAll(reply, "private-token"),
    });
    assert(!JSON.stringify(redacted).includes("private-token"));
    const richRows = input.raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const message = richRows.find((row) => row.kind === "message");
    message.raw.message.content.text.entities = [
      { offset: 0, length: 5, type: { "@type": "textEntityTypeBold" } },
    ];
    message.raw.message.reply_markup = {
      rows: [
        [
          {
            text: "Choose",
            type: { "@type": "inlineKeyboardButtonTypeCallback", data: "private-token" },
          },
        ],
      ],
    };
    const rich = normalizeTelegramCapture({
      ...input,
      raw: richRows.map((row) => JSON.stringify(row)).join("\n"),
    });
    const observed = rich["telegram-reply.json"].events.find((event) => event.kind === "message")!;
    assert.deepEqual(observed.entities, [{ offset: 0, length: 5, type: "textEntityTypeBold" }]);
    assert.deepEqual(observed.buttons, [
      [{ text: "Choose", type: "inlineKeyboardButtonTypeCallback" }],
    ]);
    assert(!JSON.stringify(rich).includes("private-token"));
    console.log(
      JSON.stringify({
        reply,
        assertion_outcome: "inconclusive",
        events: facts["telegram-reply.json"].events.length,
        bytes: Object.values(facts).reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0),
        limits: "Canonical recorder with synthetic TDLib adapter, not live Telegram",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
