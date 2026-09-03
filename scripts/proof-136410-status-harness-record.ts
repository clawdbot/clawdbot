/**
 * Real behavior proof for PR #136410 — the status Runtime line must distinguish a
 * session's recorded runtime from the runtime that owns the next turn, and must
 * NOT invent a transition between two ids that render as the same runtime.
 *
 * What is REAL here:
 *  - Session entries are written to a real SQLite session store in a temp
 *    `OPENCLAW_STATE_DIR` via the production `upsertSessionEntryCore` /
 *    `patchSessionEntryCore`, then read back with the production
 *    `loadSessionEntryReadOnly`. The retired `agentHarnessId: "codex-cli"` is
 *    asserted to survive that round trip, so the scenario is driven by a
 *    genuinely persisted id rather than an inline literal.
 *  - Stage 1 renders with the real `buildStatusMessage`, which resolves the
 *    Runtime line through the real `resolveAgentRuntimeLabel`.
 *  - Stage 2 crosses the **command boundary**: the real `getReplyFromConfig`
 *    handles an inbound Telegram `/status` message, so the session entry is
 *    loaded, the sender authorized, and the harness resolved by production code
 *    (`resolveStatusHarnessId`) instead of being handed in by the harness.
 *  - Stage 2 then crosses the **delivery boundary**: the resulting payload is
 *    delivered by the real `routeReply` through the real bundled Telegram
 *    channel plugin, which performs a real HTTP `sendMessage` call. The captured
 *    request body is the operator-visible text, printed redacted.
 *
 * Stubbed: the temp state/config/home dirs, and the Telegram Bot API *host* —
 * substituted through the supported `channels.telegram.accounts.*.apiRoot`
 * config knob, so the Telegram channel plugin, its HTTP client, and the whole
 * outbound delivery stack are the production ones. Nothing between the command
 * entrypoint and the HTTP edge is faked.
 *
 * Not proven here, stated rather than papered over:
 *  - The `session pin` wording. Case 7 shows why it cannot appear on `/status`:
 *    a locked harness *is* the runtime that owns the next turn there, so the
 *    recorded id and the displayed runtime coincide and the annotation is
 *    correctly suppressed. It renders on the session-summary surface
 *    (`statusSummaryRuntime.resolveSessionRuntime`) only when the displayed
 *    runtime comes from the session's own CLI provider, and that classification
 *    requires a plugin owning the `claude-cli` backend in the installed-plugin
 *    index. Installing a fixture plugin needs the repository build, which this
 *    host cannot run, so scenario 3 covers the wording at the label level only.
 *  - Telegram's own Test Server. That harness
 * (`.agents/skills/telegram-e2e-userbot`) leases credentials through an
 * owner-only Convex broker; on a contributor host its doctor reports
 * `{"ok":false,"error":"Could not load the QA broker through the Convex CLI..."}`.
 * A dist-backed real-Gateway variant is also unavailable here: the repository
 * build refuses to start under this host's heap ("a full build needs 4352MB,
 * peaking near 4.7GB").
 *
 * Scenarios:
 *  Stage 1 — label rendering over persisted state
 *   1. RETIRED-ALIAS (the regression): persisted `codex-cli`, live runtime `codex`.
 *      `AGENT_RUNTIME_LABELS` renders both as "OpenAI Codex", so annotating a
 *      transition would read `OpenAI Codex (previous runtime: OpenAI Codex)` —
 *      a runtime change that never happened. Must render a bare `OpenAI Codex`.
 *   2. REAL-TRANSITION control: persisted `openclaw`, live runtime `codex`. Must
 *      still annotate `(previous runtime: OpenClaw Default)`.
 *   3. SESSION-PIN control: same as 2 but `modelSelectionLocked`, so the
 *      relationship word must be `session pin`.
 *   4. RETIRED-ALIAS REAL-TRANSITION control: persisted `codex-cli`, live runtime
 *      `claude-cli`. The alias must not swallow a genuine transition — this pins
 *      that the fix suppresses only same-label pairs.
 *  Stage 2 — real `/status` command + real Telegram delivery
 *   5. UNLOCKED DIVERGENT: persisted `openclaw`, configured provider runtime
 *      `codex`. Delivered text must annotate `(previous runtime: OpenClaw Default)`.
 *   6. UNLOCKED RETIRED ALIAS: persisted `codex-cli`, configured runtime `codex`.
 *      Delivered text must show one runtime and no relationship annotation.
 *   7. LOCKED: persisted `openclaw` + `modelSelectionLocked`. A locked pin owns
 *      the next turn, so `/status` must present it as the current runtime with no
 *      annotation — history and pin stay distinct rather than both being narrated.
 *
 * Run: pnpm tsx scripts/proof-136410-status-harness-record.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Heartbeat from a worker thread: a main-thread setInterval does not fire during
// a synchronous tsx/jiti compile, and a silent proof reads as a hung proof.
const heartbeat = new Worker(
  `const { writeSync } = require("node:fs");
   let n = 0;
   setInterval(() => { writeSync(1, "[proof] still running (" + (++n) * 5 + "s)\\n"); }, 5000).unref?.();
   setInterval(() => {}, 1 << 30);`,
  { eval: true, stdout: false },
);

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    console.log(`  PASS ${label}: ${JSON.stringify(actual)}`);
  } else {
    failed += 1;
    console.log(
      `  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const BOT_TOKEN = "424242:proof-136410-status-harness";
const CHAT_ID = 913610;
const SENDER_ID = 913611;
const ACCOUNT_ID = "proof";
const AGENT_ID = "main";
const MODEL_PROVIDER = "proofopenai";
const MODEL_ID = "proof-status-model";
const MODEL_REF = `${MODEL_PROVIDER}/${MODEL_ID}`;

/** Keeps captured operator text publishable: no host paths, tokens, or chat ids. */
function redact(text: string, replacements: readonly [string, string][]): string {
  let out = text;
  for (const [from, to] of replacements) {
    if (from) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

function runtimeLineOf(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.includes("Runtime:"))
      ?.trim() ?? ""
  );
}

async function main(): Promise<void> {
  console.log("proof-136410: status Runtime line, persisted harness id vs live runtime");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-136410-state-"));
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  const configPath = path.join(tempRoot, "openclaw.json");
  for (const dir of [stateDir, homeDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Hermetic: every read and write this proof performs stays inside tempRoot.
  process.env.HOME = homeDir;
  process.env.OPENCLAW_HOME = homeDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  let server: http.Server | undefined;
  try {
    await runProof({
      tempRoot,
      stateDir,
      homeDir,
      workspaceDir,
      configPath,
      setServer: (s) => (server = s),
    });
  } finally {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    // Terminate the heartbeat worker first, then remove the temp state so a
    // repeated maintainer run never inherits or leaves behind SQLite state —
    // on assertion failure, on a thrown import, and on success alike.
    await heartbeat.terminate();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log(
      `\n[cleanup] removed proof state dir: exists=${fs.existsSync(tempRoot)} (${tempRoot})`,
    );
  }
}

async function runProof(params: {
  tempRoot: string;
  stateDir: string;
  homeDir: string;
  workspaceDir: string;
  configPath: string;
  setServer: (server: http.Server) => void;
}): Promise<void> {
  const { tempRoot, stateDir, workspaceDir, configPath } = params;
  // Stage 1's own store lives outside the state dir so anything the real command
  // path creates under OPENCLAW_STATE_DIR is unambiguously the command path's.
  const storePath = path.join(tempRoot, "stage1", "sessions.sqlite");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  const { patchSessionEntryCore, upsertSessionEntryCore } =
    await import("../src/config/sessions/session-accessor.js");
  const { loadSessionEntryReadOnly, listSessionEntryKeysReadOnly } =
    await import("../src/config/sessions/session-accessor.sqlite-entry.js");
  const { buildStatusMessage } = await import("../src/status/status-message.js");

  // ---------------------------------------------------------------- Stage 1 --
  console.log("\n########## Stage 1: persisted state -> real buildStatusMessage ##########");

  async function persistAndRender(scenario: {
    label: string;
    sessionKey: string;
    persistedHarnessId: string;
    resolvedHarness: string;
    modelSelectionLocked?: boolean;
  }): Promise<string> {
    console.log(`\n=== ${scenario.label} ===`);
    await upsertSessionEntryCore(
      { sessionKey: scenario.sessionKey, storePath },
      {
        sessionId: scenario.sessionKey,
        updatedAt: Date.now(),
        agentHarnessId: scenario.persistedHarnessId,
        ...(scenario.modelSelectionLocked ? { modelSelectionLocked: true } : {}),
      },
    );

    // Read the entry back out of SQLite: the scenario must be driven by what the
    // store actually holds, not by the object we just handed it.
    const stored = loadSessionEntryReadOnly({ sessionKey: scenario.sessionKey, storePath });
    check(
      "persisted agentHarnessId round-tripped",
      stored?.agentHarnessId,
      scenario.persistedHarnessId,
    );
    if (!stored) {
      throw new Error(`session entry ${scenario.sessionKey} did not persist`);
    }

    const message = buildStatusMessage({
      agent: { model: "openai/gpt-5.4" },
      resolvedHarness: scenario.resolvedHarness,
      sessionEntry: stored,
      sessionKey: "agent:main:direct:redacted",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "oauth",
    });
    const runtimeLine = runtimeLineOf(message);
    console.log(`  rendered: ${runtimeLine}`);
    return runtimeLine;
  }

  // 1. The regression: a retired id and the current id render as one runtime.
  const retired = await persistAndRender({
    label: "RETIRED-ALIAS: persisted codex-cli, live runtime codex",
    sessionKey: "agent:main:retired-alias",
    persistedHarnessId: "codex-cli",
    resolvedHarness: "codex",
  });
  check(
    "renders the runtime once, with no invented transition",
    retired.includes("OpenAI Codex"),
    true,
  );
  check("no 'previous runtime' annotation", retired.includes("previous runtime"), false);
  check("no 'session pin' annotation", retired.includes("session pin"), false);
  check(
    "specifically not the self-referential label",
    retired.includes("OpenAI Codex (previous runtime: OpenAI Codex)"),
    false,
  );

  // 2. A genuine transition must still be reported.
  const transition = await persistAndRender({
    label: "REAL-TRANSITION control: persisted openclaw, live runtime codex",
    sessionKey: "agent:main:real-transition",
    persistedHarnessId: "openclaw",
    resolvedHarness: "codex",
  });
  check(
    "annotates the real transition",
    transition.includes("Runtime: OpenAI Codex (previous runtime: OpenClaw Default)"),
    true,
  );

  // 3. A locked session names the relationship differently.
  const locked = await persistAndRender({
    label: "SESSION-PIN control: persisted openclaw, live runtime codex, locked",
    sessionKey: "agent:main:session-pin",
    persistedHarnessId: "openclaw",
    resolvedHarness: "codex",
    modelSelectionLocked: true,
  });
  check(
    "annotates the pin as a session pin",
    locked.includes("Runtime: OpenAI Codex (session pin: OpenClaw Default)"),
    true,
  );

  // 4. The alias must not swallow a genuine transition away from Codex.
  const aliasTransition = await persistAndRender({
    label: "RETIRED-ALIAS REAL-TRANSITION control: persisted codex-cli, live runtime claude-cli",
    sessionKey: "agent:main:alias-transition",
    persistedHarnessId: "codex-cli",
    resolvedHarness: "claude-cli",
  });
  check(
    "still annotates a real transition from the retired id",
    aliasTransition.includes("Runtime: Claude CLI (previous runtime: OpenAI Codex)"),
    true,
  );

  // ---------------------------------------------------------------- Stage 2 --
  console.log(
    "\n########## Stage 2: real /status command boundary -> real Telegram delivery ##########",
  );

  const telegramCalls: { method: string; body: Record<string, unknown> }[] = [];
  const apiRoot = await new Promise<string>((resolve, reject) => {
    const created = http.createServer((req, res) => {
      void (async () => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const match = pathname.match(/^\/bot([^/]+)\/([^/]+)$/);
        let text = "";
        for await (const chunk of req) {
          text += String(chunk);
        }
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const send = (payload: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (!match || match[1] !== BOT_TOKEN) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unexpected bot endpoint" }));
          return;
        }
        const method = match[2] ?? "";
        if (method === "getMe") {
          send({
            ok: true,
            result: {
              id: 424242,
              is_bot: true,
              first_name: "Proof Bot",
              username: "proof_136410_bot",
            },
          });
          return;
        }
        if (method === "getUpdates") {
          send({ ok: true, result: [] });
          return;
        }
        telegramCalls.push({ method, body });
        if (method === "sendMessage") {
          send({
            ok: true,
            result: {
              message_id: 5000 + telegramCalls.length,
              date: 1_756_000_000,
              chat: { id: CHAT_ID, type: "private" },
              text: String(body.text ?? ""),
            },
          });
          return;
        }
        send({ ok: true, result: true });
      })().catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      });
    });
    created.once("error", reject);
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not bind the Telegram Bot API stand-in"));
        return;
      }
      params.setServer(created);
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { finalizeInboundContext } = await import("../src/auto-reply/reply/inbound-context.js");
  const { getReplyFromConfig } = await import("../src/auto-reply/reply/get-reply.js");
  const { routeReply } = await import("../src/auto-reply/reply/route-reply.js");
  type OpenClawConfig = import("../src/config/types.openclaw.js").OpenClawConfig;

  // A provider-scoped agentRuntime policy is how an operator pins the runtime that
  // owns the next turn; the status path resolves it through resolveStatusHarnessId.
  const cfg = {
    plugins: { enabled: true, allow: ["telegram"], entries: { telegram: { enabled: true } } },
    channels: {
      telegram: {
        enabled: true,
        defaultAccount: ACCOUNT_ID,
        accounts: {
          [ACCOUNT_ID]: {
            enabled: true,
            botToken: BOT_TOKEN,
            apiRoot,
            dmPolicy: "open",
            allowFrom: ["*"],
            commands: { native: true },
          },
        },
      },
    },
    agents: {
      defaults: {
        model: MODEL_REF,
        workspace: workspaceDir,
        modelPolicy: { allow: [MODEL_REF] },
        models: { [MODEL_REF]: {} },
      },
      entries: { [AGENT_ID]: { model: MODEL_REF } },
    },
    models: {
      mode: "merge",
      providers: {
        [MODEL_PROVIDER]: {
          baseUrl: apiRoot,
          api: "openai-responses",
          apiKey: "proof-key",
          agentRuntime: { id: "codex" },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 256,
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

  const inboundStatusCtx = () =>
    finalizeInboundContext({
      Body: "/status",
      CommandBody: "/status",
      CommandSource: "native",
      From: String(SENDER_ID),
      To: String(CHAT_ID),
      SenderId: String(SENDER_ID),
      ChatType: "direct",
      Provider: "telegram",
      Surface: "telegram",
      AccountId: ACCOUNT_ID,
      CommandAuthorized: true,
    } as never);

  // A real turn creates the session; the divergent metadata is then persisted and
  // read back by production code on the next real turn.
  console.log("\n=== seeding: real /status turn creates the session ===");
  const seeded = await getReplyFromConfig(inboundStatusCtx(), undefined, cfg);
  const seededPayload = Array.isArray(seeded) ? seeded[0] : seeded;
  check("the real command path produced a /status reply", Boolean(seededPayload?.text), true);

  const stateFiles = (function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...walk(full));
      } else {
        found.push(full);
      }
    }
    return found;
  })(stateDir);
  console.log(`  files the real command path created under OPENCLAW_STATE_DIR:`);
  for (const file of stateFiles) {
    console.log(`    ${path.relative(stateDir, file)}`);
  }
  // Discover the store the command path chose by asking the production read-only
  // accessor which candidate actually holds session entries.
  let commandStorePath: string | undefined;
  let commandSessionKey: string | undefined;
  for (const candidate of stateFiles.filter((file) => file.endsWith(".sqlite"))) {
    const keys = (() => {
      try {
        return listSessionEntryKeysReadOnly({ storePath: candidate });
      } catch {
        return [];
      }
    })();
    if (keys.length > 0) {
      commandStorePath = candidate;
      commandSessionKey = keys[0];
      break;
    }
  }
  check("the real command path persisted a session entry", Boolean(commandSessionKey), true);
  if (!commandStorePath || !commandSessionKey) {
    throw new Error("the real command path persisted no session entry");
  }
  console.log(
    `  command-path session store: ${path.relative(stateDir, commandStorePath)} (1 of ${stateFiles.length} state files)`,
  );
  // Narrow once: the discovery loop uses `let`, which closures cannot narrow.
  const sessionKey = commandSessionKey;
  const sessionStorePath = commandStorePath;

  const redactions: readonly [string, string][] = [
    [tempRoot, "<PROOF_TMP>"],
    [os.homedir(), "<HOME>"],
    [BOT_TOKEN, "<BOT_TOKEN>"],
    [apiRoot, "<TELEGRAM_API_ROOT>"],
    [sessionKey, "<SESSION_KEY>"],
    [String(CHAT_ID), "<CHAT_ID>"],
    [String(SENDER_ID), "<SENDER_ID>"],
  ];

  async function deliverRealStatus(scenario: {
    label: string;
    persistedHarnessId: string;
    modelSelectionLocked: boolean;
  }): Promise<string> {
    console.log(`\n=== ${scenario.label} ===`);
    await patchSessionEntryCore({ sessionKey, storePath: sessionStorePath }, () => ({
      agentHarnessId: scenario.persistedHarnessId,
      modelSelectionLocked: scenario.modelSelectionLocked,
    }));
    const stored = loadSessionEntryReadOnly({
      sessionKey,
      storePath: sessionStorePath,
    });
    check("divergent metadata round-tripped", stored?.agentHarnessId, scenario.persistedHarnessId);
    check(
      "lock state round-tripped",
      stored?.modelSelectionLocked === true,
      scenario.modelSelectionLocked,
    );

    const before = telegramCalls.length;
    const reply = await getReplyFromConfig(inboundStatusCtx(), undefined, cfg);
    const payload = Array.isArray(reply) ? reply[0] : reply;
    check("real /status command returned a payload", Boolean(payload?.text), true);
    if (!payload) {
      throw new Error("the real /status command returned no payload");
    }

    const routed = await routeReply({
      payload,
      channel: "telegram",
      to: String(CHAT_ID),
      accountId: ACCOUNT_ID,
      cfg,
      sessionKey,
    } as never);
    check("real routeReply delivered through the Telegram plugin", routed.delivered, true);

    const sent = telegramCalls.slice(before).filter((call) => call.method === "sendMessage");
    check("exactly one Telegram sendMessage reached the Bot API edge", sent.length, 1);
    const deliveredText = String(sent[0]?.body.text ?? "");
    console.log("  --- redacted delivered Telegram sendMessage.text ---");
    for (const line of redact(deliveredText, redactions).split("\n")) {
      console.log(`  | ${line}`);
    }
    console.log("  --- end delivered text ---");
    return deliveredText;
  }

  // 5. Unlocked divergent history must be narrated as history.
  const deliveredDivergent = await deliverRealStatus({
    label: "REAL /status, UNLOCKED DIVERGENT: persisted openclaw, configured runtime codex",
    persistedHarnessId: "openclaw",
    modelSelectionLocked: false,
  });
  check(
    "delivered text annotates the previous runtime",
    runtimeLineOf(deliveredDivergent).includes("(previous runtime: OpenClaw Default)"),
    true,
  );
  check(
    "delivered text does not call unlocked history a session pin",
    deliveredDivergent.includes("session pin"),
    false,
  );

  // 6. The retired alias must not invent a transition on the real command path.
  const deliveredAlias = await deliverRealStatus({
    label: "REAL /status, UNLOCKED RETIRED ALIAS: persisted codex-cli, configured runtime codex",
    persistedHarnessId: "codex-cli",
    modelSelectionLocked: false,
  });
  const aliasRuntimeLine = runtimeLineOf(deliveredAlias);
  check("delivered text names the Codex runtime", aliasRuntimeLine.includes("OpenAI Codex"), true);
  check(
    "delivered text invents no transition between two ids under one name",
    aliasRuntimeLine.includes("previous runtime") || aliasRuntimeLine.includes("session pin"),
    false,
  );

  // 7. A locked pin owns the next turn, so /status presents it as current.
  const deliveredLocked = await deliverRealStatus({
    label: "REAL /status, LOCKED: persisted openclaw + modelSelectionLocked",
    persistedHarnessId: "openclaw",
    modelSelectionLocked: true,
  });
  const lockedRuntimeLine = runtimeLineOf(deliveredLocked);
  check(
    "delivered text presents the locked pin as the current runtime",
    lockedRuntimeLine.includes("OpenClaw Default"),
    true,
  );
  check(
    "delivered text does not narrate a locked pin as a past transition",
    lockedRuntimeLine.includes("previous runtime"),
    false,
  );

  console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertions)`);
}

let exitCode = 0;
try {
  await main();
  if (failed > 0) {
    console.log("Runtime assertions FAILED.");
    exitCode = 1;
  } else {
    console.log("All runtime assertions passed.");
  }
} catch (error: unknown) {
  console.error(error);
  exitCode = 1;
}
process.exit(exitCode);
