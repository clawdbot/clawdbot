import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { normalizeTelegramCapture } from "../../scripts/mantis/telegram-capture.ts";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";
import {
  parseTelegramProofPlan,
  type TelegramProofPlan,
} from "../../scripts/mantis/telegram-proof-plan.ts";
import { prepareTelegramQaDevice } from "../../scripts/mantis/telegram-qa-device.ts";
import {
  telegramProofIdentitySchema,
  verifyTelegramProofFiles,
} from "../../scripts/mantis/telegram-request-proof.ts";
import {
  assertCurrentTelegramRequest,
  redeemTelegramReviewProof,
} from "../../scripts/mantis/telegram-run-admission.ts";
import { createDeferred } from "../helpers/promise.js";
const plan: TelegramProofPlan = {
  claim: "A selected reply is observed",
  actions: [{ type: "send", atMs: 0, text: "hello" }],
  modelReplies: ["reply"],
  settings: { streaming: "off", nativeCommands: false },
  maxDurationMs: 1000,
  expectations: ["The bot answers reply"],
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
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const identity = telegramProofIdentitySchema.parse({
  request_id: "a".repeat(64),
  plan_sha256: hash(plan),
  repository: { id: "1", full_name: "openclaw/openclaw" },
  pull_request: 1,
  candidate_sha: "b".repeat(40),
  scenario: "telegram-bot-e2e-proof",
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "2", attempt: 1 },
});
describe("Bounded model-selected plan", () => {
  it("hashes recursively sorted keys while retaining action order", () => {
    expect(parseTelegramProofPlan(JSON.stringify(plan), hash(plan))).toEqual(plan);
    expect(parseTelegramProofPlan(canonical(plan), hash(plan))).toEqual(plan);
    expect(() =>
      parseTelegramProofPlan(JSON.stringify({ ...plan, claim: "changed" }), hash(plan)),
    ).toThrow(/digest/);
  });
  it.each([
    { ...plan, command: "curl attacker" },
    { ...plan, actions: [{ type: "exec", command: "pwd", atMs: 0 }] },
    { ...plan, actions: [{ type: "send", text: "hello", atMs: 1000 }] },
    { ...plan, settings: { ...plan.settings, env: { TOKEN: "x" } } },
  ])("rejects executable or out-of-budget data", (input) => {
    expect(() => parseTelegramProofPlan(JSON.stringify(input), hash(input))).toThrow();
  });
});
async function capture(reply = "reply") {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-record-"));
  try {
    execFileSync(
      "python",
      [
        "test/fixtures/mantis-telegram-recorder.py",
        path.resolve(".agents/skills/telegram-e2e-userbot/scripts/user-record.py"),
        root,
        "hello",
        reply,
      ],
      { timeout: 10000 },
    );
    return {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe("Complete canonical recorder observations", () => {
  it("rejects a Web UI workflow identity relabeled as Telegram", () => {
    expect(() =>
      telegramProofIdentitySchema.parse({
        ...identity,
        workflow: { ...identity.workflow, path: ".github/workflows/mantis-web-ui-chat-proof.yml" },
      }),
    ).toThrow();
  });
  it.each(["reply", "wrong reply"])(
    "records %s without declaring a semantic pass",
    async (reply) => {
      const input = await capture(reply);
      const facts = normalizeTelegramCapture(input);
      expect(facts["telegram-reply.json"].events.some((event) => event.text === reply)).toBe(true);
      expect(facts["provider-request.json"].requests).toEqual(input.provider);
      const encoded = Object.fromEntries(
        Object.entries(facts).map(([k, v]) => [
          k,
          Buffer.from(JSON.stringify(v)).toString("base64"),
        ]),
      );
      expect(verifyTelegramProofFiles(identity, encoded).assertion_outcome).toBe("inconclusive");
      const wrong = { ...identity, plan_sha256: "0".repeat(64) };
      expect(() => verifyTelegramProofFiles(wrong, encoded)).toThrow();
    },
  );
  it("redacts known private values and rejects incomplete or oversized recordings", async () => {
    const input = await capture();
    const raw = input.raw.replaceAll("reply", "private-token");
    const facts = normalizeTelegramCapture({ ...input, raw });
    expect(JSON.stringify(facts)).not.toContain("private-token");
    expect(JSON.stringify(facts)).toContain("[redacted]");
    expect(() => normalizeTelegramCapture({ ...input, quiescent: false })).toThrow();
    expect(() => normalizeTelegramCapture({ ...input, leaseHealthy: false })).toThrow();
    expect(() => normalizeTelegramCapture({ ...input, raw: input.raw.repeat(300) })).toThrow();
  });
  it("retains visible formatting and button labels without exporting callback data", async () => {
    const input = await capture();
    const rows = input.raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const message = rows.find((row) => row.kind === "message");
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
    const facts = normalizeTelegramCapture({
      ...input,
      raw: rows.map((row) => JSON.stringify(row)).join("\n"),
    });
    const observed = facts["telegram-reply.json"].events.find((event) => event.kind === "message")!;
    expect(observed.entities).toEqual([{ offset: 0, length: 5, type: "textEntityTypeBold" }]);
    expect(observed.buttons).toEqual([
      [{ text: "Choose", type: "inlineKeyboardButtonTypeCallback" }],
    ]);
    expect(JSON.stringify(facts)).not.toContain("private-token");
  });
});
async function ingressFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tg-ingress-"));
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mantis-${randomUUID()}`
      : path.join(root, "api.sock");
  const revoked = createDeferred<Error>();
  const forwarded: string[] = [];
  const responses: unknown[] = [];
  let healthy = true;
  const ingress = await startTelegramProofIngress({
    socket,
    alias: "1:fixture",
    sutToken: "private-token",
    testerId: "43",
    plan,
    providerLog: path.join(root, "provider.ndjson"),
    lease: {
      assertHealthy() {
        if (!healthy) {
          throw new Error("expired");
        }
      },
      whenUnhealthy: revoked.promise,
    },
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      forwarded.push(url.pathname);
      const method = url.pathname.split("/").at(-1);
      return Response.json({
        ok: true,
        result:
          method === "sendMessage"
            ? { message_id: 100, chat: { id: 43, type: "private" } }
            : method === "getUpdates"
              ? [
                  {
                    update_id: 1,
                    message: {
                      message_id: 99,
                      chat: { id: 43, type: "private", first_name: "Private tester" },
                      from: {
                        id: 43,
                        first_name: "Private tester",
                        last_name: "Private surname",
                        username: "private_tester",
                      },
                      text: "Unchanged scenario text",
                    },
                  },
                ]
              : method === "getMe"
                ? {
                    id: 42,
                    is_bot: true,
                    first_name: "Private bot",
                    last_name: "Private surname",
                    username: "selected_bot",
                  }
                : true,
      });
    },
  });
  const request = (method: string, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path: `/telegram/bot1:fixture/${method}`,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            responses.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            resolve(response.statusCode!);
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  return {
    ingress,
    request,
    forwarded,
    responses,
    revoke() {
      healthy = false;
      revoked.resolve(new Error("expired"));
    },
    async close() {
      await ingress.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("Selected DM capability ingress", () => {
  it("projects private profile names while preserving routing and scenario text", async () => {
    const fixture = await ingressFixture();
    try {
      fixture.ingress.armScenario();
      expect(await fixture.request("getMe", {})).toBe(200);
      expect(await fixture.request("getUpdates", { timeout: 0 })).toBe(200);
      expect(fixture.responses).toEqual([
        {
          ok: true,
          result: { id: 42, is_bot: true, first_name: "Proof user", username: "selected_bot" },
        },
        {
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 99,
                chat: { id: 43, type: "private", first_name: "Proof user" },
                from: { id: 43, first_name: "Proof user", username: "proof_user" },
                text: "Unchanged scenario text",
              },
            },
          ],
        },
      ]);
      expect(JSON.stringify(fixture.responses)).not.toContain("Private");
    } finally {
      await fixture.close();
    }
  });
  it("permits selected multiple replies and edits/deletion of messages created in this run", async () => {
    const fixture = await ingressFixture();
    try {
      fixture.ingress.armScenario();
      expect(await fixture.request("sendMessage", { chat_id: 43, text: "first" })).toBe(200);
      expect(await fixture.request("sendMessage", { chat_id: 43, text: "second" })).toBe(200);
      expect(
        await fixture.request("editMessageText", { chat_id: 43, message_id: 100, text: "edited" }),
      ).toBe(200);
      expect(await fixture.request("deleteMessage", { chat_id: 43, message_id: 100 })).toBe(200);
      expect(fixture.forwarded).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });
  it.each([
    ["sendMessage", { chat_id: 44, text: "wrong peer" }],
    ["deleteMessage", { chat_id: 43, message_id: 999 }],
    ["sendDocument", { chat_id: 43, document: "file" }],
  ])("denies out-of-scope %s and terminally fences later sends", async (method, body) => {
    const fixture = await ingressFixture();
    try {
      fixture.ingress.armScenario();
      expect(await fixture.request(method, body)).toBe(403);
      expect(await fixture.request("sendMessage", { chat_id: 43, text: "later" })).toBe(403);
      expect(fixture.forwarded).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
  it("checks authority synchronously before forwarding after revocation", async () => {
    const fixture = await ingressFixture();
    try {
      fixture.ingress.armScenario();
      fixture.revoke();
      expect(await fixture.request("sendMessage", { chat_id: 43, text: "stale" })).toBe(403);
      expect(fixture.forwarded).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
describe("Telegram proof isolation and egress", () => {
  it("prepares fresh, closed pairing state without exporting the observer private identity", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "mantis-qa-device-"));
    try {
      const deviceIdentity = await prepareTelegramQaDevice(scratch);
      expect(await readdir(scratch)).toEqual(["candidate-pairing.sqlite"]);
      const databasePath = path.join(scratch, "candidate-pairing.sqlite");
      const bytes = await readFile(databasePath);
      expect(bytes.includes(Buffer.from(deviceIdentity.privateKeyPem))).toBe(false);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(Object.values(database.prepare("PRAGMA integrity_check").get() ?? {})).toEqual([
          "ok",
        ]);
        expect(
          database.prepare("SELECT count(*) AS count FROM device_pairing_paired").get()?.count,
        ).toBe(1);
        expect(
          database.prepare("SELECT count(*) AS count FROM device_pairing_pending").get()?.count,
        ).toBe(0);
        expect(
          database.prepare("SELECT count(*) AS count FROM device_identities").get()?.count,
        ).toBe(0);
      } finally {
        database.close();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
describe("Telegram live-send admission", () => {
  it("redeems only the fixed review endpoint with the selected plan and trusted OIDC audience", async () => {
    vi.stubEnv(
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "https://fixture.actions.githubusercontent.com/oidc",
    );
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "synthetic-request-token");
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
      if (init.body != null && typeof init.body !== "string") {
        throw new Error("Expected a JSON string request body");
      }
      requests.push({ url: String(input), body: init.body ? JSON.parse(init.body) : null });
      return requests.length === 1
        ? Response.json({ value: "synthetic-oidc-token" })
        : Response.json({ ok: true, expiresAt: 12345 });
    });
    try {
      expect(await redeemTelegramReviewProof(identity)).toBe(12345);
      const endpoint = "https://clawsweeper.openclaw.ai/internal/exact-review/proof/producer";
      expect(new URL(requests[0]!.url).searchParams.get("audience")).toBe(endpoint);
      expect(requests[1]).toEqual({
        url: endpoint,
        body: {
          requestId: identity.request_id,
          planSha256: identity.plan_sha256,
          runId: "2",
          runAttempt: 1,
        },
      });
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://attacker.invalid/oidc");
      await expect(redeemTelegramReviewProof(identity)).rejects.toThrow(/Invalid Actions/);
      expect(requests).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  const title = `Mantis Telegram request [${identity.request_id}]`;
  const run = {
    id: 2,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: identity.workflow.path,
    head_sha: identity.workflow.sha,
    display_title: title,
    created_at: "2026-09-05T00:00:00Z",
    repository: { id: 1 },
    head_repository: { id: 1 },
  };
  const request = async (
    options: { staleRead?: number; attempt?: number; runPath?: string; workflowRef?: string } = {},
  ) => {
    const subject = telegramProofIdentitySchema.parse({
      ...identity,
      run: { ...identity.run, attempt: options.attempt ?? 1 },
    });
    let pullReads = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/actions/runs/2/attempts/1")) {
        return Response.json({ ...run, path: options.runPath ?? run.path });
      }
      if (url.pathname.endsWith("/pulls/1")) {
        pullReads += 1;
        return Response.json({
          state: "open",
          head: {
            sha: options.staleRead === pullReads ? "0".repeat(40) : identity.candidate_sha,
            repo: { id: 1 },
          },
        });
      }
      throw new Error(`Unexpected admission URL: ${url}`);
    };
    return assertCurrentTelegramRequest(subject, {
      token: "test-token",
      workflowRef: options.workflowRef,
      fetchImpl,
    });
  };

  it("binds attempt one and rechecks the exact PR head after awaited admission reads", async () => {
    await expect(request()).resolves.toBeUndefined();
    await expect(request({ staleRead: 1 })).rejects.toThrow(/no longer current/);
    await expect(request({ staleRead: 2 })).rejects.toThrow(/no longer current/);
    await expect(request({ attempt: 2 })).rejects.toThrow(/expected 1/);
  });

  it("accepts only a plain path or a qualifier matching the trusted workflow branch", async () => {
    const workflowRef = "refs/heads/qa-proof";
    await expect(request({ workflowRef })).resolves.toBeUndefined();
    await expect(
      request({ workflowRef, runPath: `${run.path}@qa-proof` }),
    ).resolves.toBeUndefined();
    for (const qualifier of ["", "other", identity.candidate_sha]) {
      await expect(request({ workflowRef, runPath: `${run.path}@${qualifier}` })).rejects.toThrow(
        /does not match/,
      );
    }
    for (const missingOrTagRef of [undefined, "refs/heads/", "refs/tags/qa-proof"]) {
      await expect(
        request({ workflowRef: missingOrTagRef, runPath: `${run.path}@qa-proof` }),
      ).rejects.toThrow(/does not match/);
    }
  });
});
