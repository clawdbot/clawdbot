import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishableRecorderArtifacts,
  publishStartupFailure,
  startDesktopRecorder,
} from "../../scripts/e2e/telegram-mantis-lane.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const laneScript = path.resolve("scripts/e2e/telegram-mantis-lane.ts");

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function setupHarness(
  options: { failEvents?: boolean; failRecorder?: boolean; userOnlyEvents?: boolean } = {},
) {
  const root = tempDirs.make("telegram-mantis-lane-");
  const outputRoot = path.join(root, "public");
  const sessionRoot = path.join(root, "private");
  const credentialFile = path.join(root, "credential.json");
  const observerSocket = path.join(root, "observer.sock");
  const recorderControlLog = path.join(root, "recorder-control.json");
  const recorderLog = path.join(root, "recorder.log");
  const recorderCommand = path.join(root, "recorder");
  const userDriverCommand = path.join(root, "user-driver");
  const binDir = path.join(root, "bin");
  const screenshot = path.join(root, "proof.png");
  const previewGif = path.join(root, "proof.gif");
  const trimmedVideo = path.join(root, "proof.mp4");
  const proxyControl = path.join(root, "proxy-control.json");
  const proxyRequestLog = path.join(root, "proxy-requests.ndjson");
  const requestLog = path.join(root, "requests.ndjson");
  const gatewayLog = path.join(root, "gateway.log");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(sessionRoot);
  fs.mkdirSync(path.join(sessionRoot, "attempt"));
  fs.mkdirSync(binDir);
  writeJson(credentialFile, {
    groupId: "-100123456789",
    sutToken: "123456:secret-sut-token",
    testerUserId: "77",
  });
  writeJson(path.join(root, "mock-response.json"), { chunkDelayMs: 0, text: "initial" });
  writeJson(proxyControl, { rules: [] });
  fs.writeFileSync(proxyRequestLog, "");
  fs.writeFileSync(requestLog, "");
  fs.writeFileSync(gatewayLog, "");
  fs.writeFileSync(
    screenshot,
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(10_001)]),
  );
  fs.writeFileSync(previewGif, Buffer.alloc(10_001));
  fs.writeFileSync(trimmedVideo, Buffer.alloc(10_001));
  fs.writeFileSync(
    recorderCommand,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(recorderLog)}\ncp ${JSON.stringify(path.join(root, "mock-response.json"))} ${JSON.stringify(recorderControlLog)}\n${options.failRecorder ? "exit 1\n" : ""}if [ "$1" = artifacts ]; then\n  printf '%s\\n' ${JSON.stringify(JSON.stringify({ artifacts: { previewGifCropped: previewGif, screenshot, trimmedVideoCropped: trimmedVideo } }))}\nelif [ "$1" = actions ]; then\n  printf '%s\\n' ${JSON.stringify(JSON.stringify({ results: [{ command: "click", stderr: "", stdout: "clicked\n" }] }))}\nfi\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(userDriverCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "sudo"),
    `#!/bin/sh
case "$3" in
  exec)
    printf '123456:secret-sut-token 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '
    head -c 70000 /dev/zero | tr '\\0' x
    printf '123456:secret-sut-token 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ' >&2
    head -c 70000 /dev/zero | tr '\\0' y >&2
    exit 17
    ;;
  restart)
    printf 'restart requested\\n[gateway] ready\\n' >> ${JSON.stringify(gatewayLog)}
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeJson(path.join(sessionRoot, "candidate.active.json"), {
    attempt: 1,
    config: { mockResponse: "visible result" },
    invocations: [{ args: {}, at: "2026-08-19T12:00:00.000Z", command: "start", cursor: 0 }],
    lane: "candidate",
    lastCursor: 0,
    observeSeconds: 0,
    observerJournal: path.join(root, "events.ndjson"),
    observerLog: path.join(root, "observer.log"),
    observerPidFile: path.join(root, "observer.pid.json"),
    observerSocket,
    privateDir: path.join(sessionRoot, "attempt"),
    recorderSession: path.join(sessionRoot, "desktop-recorder.json"),
    repoRoot: "/prepared/candidate",
    sendCount: 0,
    startedAt: new Date().toISOString(),
    sut: {
      containerName: "openclaw-telegram-sut-test",
      gatewayLog,
      mockLog: path.join(root, "mock.log"),
      mockResponseControl: path.join(root, "mock-response.json"),
      proxyControl,
      proxyRequestLog,
      requestLog,
      sutAttestation: { lane: "candidate", sha: "a".repeat(40) },
      tempRoot: path.join(root, "sut"),
    },
  });
  const requests: Record<string, unknown>[] = [];
  let cursor = 0;
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk.toString();
    });
    socket.on("end", () => {
      const request = JSON.parse(input) as Record<string, unknown>;
      requests.push(request);
      if (request.command === "send") {
        cursor += 1;
        socket.end(
          `${JSON.stringify({ ok: true, cursor, sent: { actor: "user", kind: "message", messageId: "101", text: request.text } })}\n`,
        );
      } else if (options.failEvents) {
        socket.end(`${JSON.stringify({ ok: false, error: "observer failed after send" })}\n`);
      } else {
        cursor += 2;
        socket.end(
          `${JSON.stringify({
            ok: true,
            cursor,
            events: options.userOnlyEvents
              ? [{ actor: "user", kind: "message", messageId: "101", seq: cursor, text: "sent" }]
              : [
                  {
                    actor: "bot",
                    kind: "message",
                    messageId: "102",
                    seq: cursor - 1,
                    text: "draft",
                  },
                  { actor: "bot", kind: "edit", messageId: "102", seq: cursor, text: "final" },
                ],
          })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(observerSocket, resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
    env: {
      ...process.env,
      OPENCLAW_MANTIS_CREDENTIAL_FILE: credentialFile,
      OPENCLAW_MANTIS_OUTPUT_ROOT: outputRoot,
      OPENCLAW_MANTIS_SESSION_ROOT: sessionRoot,
      OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD: recorderCommand,
      OPENCLAW_TELEGRAM_USER_DRIVER_CMD: userDriverCommand,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    outputRoot,
    proxyControl,
    proxyRequestLog,
    recorderControlLog,
    recorderLog,
    requestLog,
    requests,
    sessionRoot,
  };
}

async function runLane(env: NodeJS.ProcessEnv, args: string[]) {
  return await execFileAsync(process.execPath, ["--import", "tsx", laneScript, ...args], {
    cwd: process.cwd(),
    env,
  });
}

describe("Telegram Mantis free-form lane", () => {
  it("passes one run-scoped recorder session across sequential lane starts", async () => {
    const root = tempDirs.make("telegram-mantis-recorder-reuse-");
    const sessionRoot = path.join(root, "private");
    const recorderCommand = path.join(root, "recorder");
    const recorderLog = path.join(root, "recorder.log");
    const provisionLog = path.join(root, "provision.log");
    fs.mkdirSync(sessionRoot);
    fs.writeFileSync(
      recorderCommand,
      `#!/bin/sh
session=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --session ]; then session=$2; break; fi
  shift
done
printf '%s\\n' "$session" >> ${JSON.stringify(recorderLog)}
if [ ! -f ${JSON.stringify(sessionRoot)}/"$session" ]; then
  printf 'provision\\n' >> ${JSON.stringify(provisionLog)}
  : > ${JSON.stringify(sessionRoot)}/"$session"
fi
`,
      { mode: 0o755 },
    );
    const priorSessionRoot = process.env.OPENCLAW_MANTIS_SESSION_ROOT;
    process.env.OPENCLAW_MANTIS_SESSION_ROOT = sessionRoot;
    try {
      for (const [lane, attempt] of [
        ["baseline", "1"],
        ["candidate", "1"],
      ] as const) {
        await startDesktopRecorder({
          chat: "-100123456789",
          outputDir: path.join(sessionRoot, "attempts", lane, attempt),
          recorderCommand,
          sessionPath: path.join(sessionRoot, "desktop-recorder.json"),
          sessionRoot,
          userDriver: "/usr/local/bin/telegram-user-driver",
        });
      }
    } finally {
      if (priorSessionRoot === undefined) {
        delete process.env.OPENCLAW_MANTIS_SESSION_ROOT;
      } else {
        process.env.OPENCLAW_MANTIS_SESSION_ROOT = priorSessionRoot;
      }
    }
    expect(fs.readFileSync(recorderLog, "utf8").trim().split("\n")).toEqual([
      "desktop-recorder.json",
      "desktop-recorder.json",
    ]);
    expect(fs.readFileSync(provisionLog, "utf8").trim().split("\n")).toEqual(["provision"]);
  });

  it("stops invoking the recorder after two authorization failures", async () => {
    const root = tempDirs.make("telegram-mantis-recorder-budget-");
    const sessionRoot = path.join(root, "private");
    const recorderCommand = path.join(root, "recorder");
    const recorderLog = path.join(root, "recorder.log");
    fs.mkdirSync(sessionRoot);
    fs.writeFileSync(
      recorderCommand,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(recorderLog)}
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-dir ]; then output=$2; break; fi
  shift
done
count=$(wc -l < ${JSON.stringify(recorderLog)})
classification=qr-unreadable
accepted=0
if [ "$count" -eq 2 ]; then classification=token-accepted-no-transition; accepted=2; fi
mkdir -p ${JSON.stringify(sessionRoot)}/"$output"
printf '{"failures":[{"acceptedTokenCount":%s,"classification":"%s","failedAt":"2026-08-22T00:00:00.000Z","loginScreenshotPath":"%s/login.png","qrAttemptCount":6}],"schemaVersion":1}\n' "$accepted" "$classification" ${JSON.stringify(sessionRoot)}/"$output" > ${JSON.stringify(sessionRoot)}/"$output"/telegram-desktop-authorization-failure.json
exit 1
`,
      { mode: 0o755 },
    );
    const priorSessionRoot = process.env.OPENCLAW_MANTIS_SESSION_ROOT;
    process.env.OPENCLAW_MANTIS_SESSION_ROOT = sessionRoot;
    const start = (attempt: number) =>
      startDesktopRecorder({
        chat: "-100123456789",
        outputDir: path.join(sessionRoot, "attempts", "candidate", String(attempt)),
        recorderCommand,
        sessionPath: path.join(sessionRoot, "desktop-recorder.json"),
        sessionRoot,
        userDriver: "/usr/local/bin/telegram-user-driver",
      });
    try {
      await expect(start(1)).rejects.toThrow();
      await expect(start(2)).rejects.toThrow(
        "desktop-unavailable: stop retrying; this run's desktop is unavailable",
      );
      await expect(start(3)).rejects.toThrow(
        /attemptCount=2, classification=token-accepted-no-transition.*loginScreenshotPath=.*login\.png/u,
      );
    } finally {
      if (priorSessionRoot === undefined) {
        delete process.env.OPENCLAW_MANTIS_SESSION_ROOT;
      } else {
        process.env.OPENCLAW_MANTIS_SESSION_ROOT = priorSessionRoot;
      }
    }
    expect(fs.readFileSync(recorderLog, "utf8").trim().split("\n")).toHaveLength(2);
    expect(
      JSON.parse(fs.readFileSync(path.join(sessionRoot, "desktop-recorder-failures.json"), "utf8")),
    ).toMatchObject({
      attemptCount: 2,
      classification: "token-accepted-no-transition",
      unavailable: true,
    });
  });

  it("publishes only cropped visual evidence", () => {
    expect(
      publishableRecorderArtifacts({
        desktopLog: "/private/desktop.log",
        ffmpegLog: "/private/ffmpeg.log",
        inspection1: "/private/inspection.png",
        previewGif: "/private/full.gif",
        previewGifCropped: "/private/cropped.gif",
        screenshot: "/private/cropped.png",
        trimmedVideo: "/private/full.mp4",
        trimmedVideoCropped: "/private/cropped.mp4",
        video: "/private/raw.mp4",
      }),
    ).toEqual({
      inspection1: "/private/inspection.png",
      previewGifCropped: "/private/cropped.gif",
      screenshot: "/private/cropped.png",
      trimmedVideoCropped: "/private/cropped.mp4",
    });
  });

  it("promotes startup failures to the canonical trusted lane result", () => {
    const root = tempDirs.make("telegram-mantis-startup-failure-");
    const outputRoot = path.join(root, "public");
    const sessionRoot = path.join(root, "private");
    fs.mkdirSync(outputRoot);
    fs.mkdirSync(sessionRoot);
    const startedAt = new Date().toISOString();
    publishStartupFailure({
      cleanupErrors: [],
      configRelative: "lane-config.json",
      error: new Error("desktop failed with 123456:secret-sut-token"),
      roots: {
        credentialFile: path.join(root, "credential.json"),
        outputRoot,
        sessionRoot,
      },
      secret: "123456:secret-sut-token",
      startup: {
        attempt: 1,
        lane: "candidate",
        observerPidFile: path.join(sessionRoot, "observer.pid.json"),
        observerRequested: false,
        observerSocket: path.join(sessionRoot, "observer.sock"),
        privateDir: path.join(sessionRoot, "attempts", "candidate", "1"),
        recorderRequested: true,
        recorderSession: path.join(sessionRoot, "desktop-recorder.json"),
        repoRoot: "/prepared/candidate",
        startedAt,
      },
      sutAttestation: { lane: "candidate", sha: "a".repeat(40) },
    });

    const facts = JSON.parse(fs.readFileSync(path.join(sessionRoot, "candidate.json"), "utf8"));
    expect(facts).toMatchObject({
      artifacts: {},
      attempt: 1,
      botApiRequests: [],
      cleanupErrors: [],
      error: "desktop failed with [redacted]",
      invocations: [
        {
          args: { config: "lane-config.json", repoRoot: "/prepared/candidate" },
          command: "start",
          cursor: 0,
        },
      ],
      lane: "candidate",
      observation: { cursor: 0, events: [], observedSeconds: 0, truncated: false },
      providerRequests: [],
      schemaVersion: 2,
      sendCount: 0,
      startedAt,
      status: "infra-error",
      sutAttestation: { lane: "candidate", sha: "a".repeat(40) },
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(sessionRoot, "published", "candidate", "mantis-lane-facts.json"),
          "utf8",
        ),
      ),
    ).toEqual(facts);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(outputRoot, "candidate", "mantis-lane-facts.json"), "utf8"),
      ),
    ).toEqual(facts);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(outputRoot, "candidate", "telegram-user-crabbox-session-summary.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      artifacts: {},
      status: "fail",
      sutAttestation: { lane: "candidate", sha: "a".repeat(40) },
    });
  });

  it("lets the agent compose sends and continuous event observations", async () => {
    const harness = await setupHarness();
    try {
      const result = await runLane(harness.env, [
        "turn",
        "--lane",
        "candidate",
        "--text",
        "show progress",
        "--observe-seconds",
        "2",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        observed: {
          events: [
            { actor: "bot", kind: "message", text: "draft" },
            { actor: "bot", kind: "edit", text: "final" },
          ],
        },
        sent: { revealedMessageId: "101", sent: { actor: "user", messageId: "101" } },
      });
      expect(harness.requests).toEqual([
        { command: "send", text: "show progress" },
        { command: "events", seconds: 2, since: 1 },
      ]);
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state).toMatchObject({
        lastCursor: 3,
        lastViewedMessageId: "101",
        observeSeconds: 2,
        sendCount: 1,
      });
      expect(state.invocations.map((entry: { command: string }) => entry.command)).toEqual([
        "start",
        "send",
        "reveal",
        "observe",
      ]);
      expect(fs.readFileSync(harness.recorderLog, "utf8")).toContain(
        "view --session desktop-recorder.json --message-id 101",
      );
      expect(JSON.parse(fs.readFileSync(harness.recorderControlLog, "utf8"))).toMatchObject({
        hold: true,
      });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(harness.outputRoot), "mock-response.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ hold: false });
      expect(result.stdout).not.toContain("secret-sut-token");
    } finally {
      await harness.close();
    }
  });

  it("keeps file inputs inside the public scenario directory", async () => {
    const harness = await setupHarness();
    const outside = path.join(path.dirname(harness.outputRoot), "outside.txt");
    fs.writeFileSync(outside, "not allowed");
    try {
      await expect(
        runLane(harness.env, ["send", "--lane", "candidate", "--text-file", outside]),
      ).rejects.toThrow("--text-file must be inside the Mantis output directory");
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("reads nested public files but refuses symlinked directory components", async () => {
    const harness = await setupHarness();
    const outside = path.join(path.dirname(harness.outputRoot), "outside.txt");
    fs.writeFileSync(outside, "not allowed");
    fs.mkdirSync(path.join(harness.outputRoot, "nested"));
    fs.writeFileSync(path.join(harness.outputRoot, "nested", "body.txt"), "nested body");
    fs.symlinkSync(path.dirname(harness.outputRoot), path.join(harness.outputRoot, "escape"));
    try {
      await runLane(harness.env, [
        "send",
        "--lane",
        "candidate",
        "--text-file",
        path.join(harness.outputRoot, "nested", "body.txt"),
      ]);
      expect(harness.requests).toEqual([{ command: "send", text: "nested body" }]);
      await expect(
        runLane(harness.env, [
          "send",
          "--lane",
          "candidate",
          "--text-file",
          path.join(harness.outputRoot, "escape", "outside.txt"),
        ]),
      ).rejects.toThrow("--text-file must be inside the Mantis output directory");
      expect(harness.requests).toEqual([{ command: "send", text: "nested body" }]);
    } finally {
      await harness.close();
    }
  });

  it("runs scenario-authored actions inside the ephemeral desktop", async () => {
    const harness = await setupHarness();
    const actions = path.join(harness.outputRoot, "click-picker.json");
    fs.writeFileSync(actions, JSON.stringify([{ command: "click", x: 120, y: 240 }]));
    try {
      const result = await runLane(harness.env, [
        "desktop",
        "--lane",
        "candidate",
        "--actions-file",
        actions,
        "--timeout-seconds",
        "90",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        actionsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        results: [{ command: "click", stdout: "clicked\n" }],
      });
      expect(fs.readFileSync(harness.recorderLog, "utf8")).toContain(
        "actions --session desktop-recorder.json --actions-file attempt/desktop-actions-2.json --timeout-seconds 90",
      );
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.invocations.at(-1)).toMatchObject({
        args: { actionsFile: "click-picker.json", timeoutSeconds: 90 },
        command: "desktop",
      });
    } finally {
      await harness.close();
    }
  });

  it("runs bounded developer shell commands and records redacted results", async () => {
    const harness = await setupHarness();
    const aliasToken = `123456:${"A".repeat(35)}`;
    const commandFile = path.join(harness.outputRoot, "inspect-state.sh");
    fs.writeFileSync(commandFile, "sqlite3 state/openclaw.sqlite '.tables'");
    try {
      const result = JSON.parse(
        (
          await runLane(harness.env, [
            "exec",
            "--lane",
            "candidate",
            "--timeout-seconds",
            "300",
            "--command",
            `printf '%s' '123456:secret-sut-token ${aliasToken}'`,
          ])
        ).stdout,
      );
      expect(result).toMatchObject({ exitCode: 17, truncated: true });
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.stringify(result)).not.toContain("secret-sut-token");
      expect(JSON.stringify(result)).not.toContain(aliasToken);

      await runLane(harness.env, ["exec", "--lane", "candidate", "--command-file", commandFile]);
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.invocations.at(-2)).toMatchObject({
        args: { command: "printf '%s' '[redacted] [redacted]'", timeoutSeconds: 300 },
        command: "exec",
        exitCode: 17,
        stderrBytes: expect.any(Number),
        stdoutBytes: expect.any(Number),
      });
      expect(state.invocations.at(-2).stdoutBytes).toBeGreaterThan(64 * 1024);
      expect(state.invocations.at(-2).stderrBytes).toBeGreaterThan(64 * 1024);
      expect(state.invocations.at(-1)).toMatchObject({
        args: { command: "sqlite3 state/openclaw.sqlite '.tables'", timeoutSeconds: 120 },
        command: "exec",
        exitCode: 17,
      });
      expect(JSON.stringify(state.invocations)).not.toContain("secret-sut-token");
      expect(JSON.stringify(state.invocations)).not.toContain(aliasToken);

      await expect(
        runLane(harness.env, [
          "exec",
          "--lane",
          "candidate",
          "--command",
          "true",
          "--command-file",
          commandFile,
        ]),
      ).rejects.toThrow("exec needs exactly one of --command or --command-file");
    } finally {
      await harness.close();
    }
  });

  it("restarts the gateway and waits for a fresh readiness marker", async () => {
    const harness = await setupHarness();
    const gatewayLog = path.join(path.dirname(harness.outputRoot), "gateway.log");
    fs.writeFileSync(gatewayLog, "[gateway] ready\nold marker\n");
    try {
      const result = JSON.parse(
        (
          await runLane(harness.env, [
            "restart",
            "--lane",
            "candidate",
            "--ready-timeout-seconds",
            "5",
          ])
        ).stdout,
      );
      expect(result).toMatchObject({
        readyAfterMs: expect.any(Number),
        restartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        status: "ready",
      });
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.invocations.at(-1)).toMatchObject({
        args: { readyAfterMs: expect.any(Number), readyTimeoutSeconds: 5 },
        command: "restart",
      });
      expect(fs.readFileSync(gatewayLog, "utf8")).toContain("restart requested");
    } finally {
      await harness.close();
    }
  });

  it("advertises developer shell commands and keeps the send cap as flood safety", async () => {
    const harness = await setupHarness();
    const active = path.join(harness.sessionRoot, "candidate.active.json");
    const state = JSON.parse(fs.readFileSync(active, "utf8"));
    state.sendCount = 39;
    writeJson(active, state);
    try {
      const help = await runLane(harness.env, ["--help"]);
      expect(help.stdout).toContain("exec");
      expect(help.stdout).toContain("restart");
      await runLane(harness.env, ["send", "--lane", "candidate", "--text", "send forty"]);
      await expect(
        runLane(harness.env, ["send", "--lane", "candidate", "--text", "send forty-one"]),
      ).rejects.toThrow("The 40-message session budget is exhausted");
    } finally {
      await harness.close();
    }
  });

  it("records desktop actions before a timeout or failure", async () => {
    const harness = await setupHarness({ failRecorder: true });
    const actions = path.join(harness.outputRoot, "failed-actions.json");
    fs.writeFileSync(actions, JSON.stringify([{ command: "click", x: 120, y: 240 }]));
    try {
      await expect(
        runLane(harness.env, ["desktop", "--lane", "candidate", "--actions-file", actions]),
      ).rejects.toThrow();
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.invocations.at(-1)).toMatchObject({
        args: {
          actionsFile: "failed-actions.json",
          actionsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          timeoutSeconds: 60,
        },
        command: "desktop",
      });
    } finally {
      await harness.close();
    }
  });

  it("retains the sent message when revealing it fails", async () => {
    const harness = await setupHarness({ failRecorder: true });
    try {
      await expect(
        runLane(harness.env, ["send", "--lane", "candidate", "--text", "keep this send"]),
      ).rejects.toThrow();
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.sendCount).toBe(1);
      expect(state.invocations.at(-1)).toMatchObject({ command: "send" });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(harness.outputRoot), "mock-response.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ hold: false });
    } finally {
      await harness.close();
    }
  });

  it("updates provider behavior through a private data file", async () => {
    const harness = await setupHarness();
    const responseFile = path.join(harness.outputRoot, "response.txt");
    fs.writeFileSync(responseFile, "stream this response");
    try {
      const result = await runLane(harness.env, [
        "mock",
        "--lane",
        "candidate",
        "--response-file",
        responseFile,
        "--chunk-delay-ms",
        "250",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ bytes: 20, chunkDelayMs: 250 });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(harness.outputRoot), "mock-response.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        chunkDelayMs: 250,
        text: "stream this response",
      });
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("passes arbitrary Responses API events to the mock provider", async () => {
    const harness = await setupHarness();
    const eventsFile = path.join(harness.outputRoot, "response-events.json");
    const events = [
      { delta: "< / internal", type: "response.reasoning_text.delta" },
      { delta: "VISIBLE", type: "response.output_text.delta" },
      { response: { output: [], status: "completed" }, type: "response.completed" },
    ];
    fs.writeFileSync(eventsFile, JSON.stringify(events));
    try {
      const result = await runLane(harness.env, [
        "mock",
        "--lane",
        "candidate",
        "--response-events-file",
        eventsFile,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ events: 3 });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(harness.outputRoot), "mock-response.json"),
            "utf8",
          ),
        ),
      ).toEqual({ events });
    } finally {
      await harness.close();
    }
  });

  it("materializes a verified per-request provider script into private control", async () => {
    const harness = await setupHarness();
    const eventsFile = path.join(harness.outputRoot, "turn-events.json");
    const scriptFile = path.join(harness.outputRoot, "provider-script.json");
    fs.writeFileSync(eventsFile, JSON.stringify([{ type: "response.completed", response: {} }]));
    fs.writeFileSync(
      scriptFile,
      JSON.stringify({
        responses: [
          { chunkDelayMs: 50, text: "first" },
          { eventsFile: "turn-events.json" },
          { fail: { status: 503 } },
        ],
        default: { fail: { mode: "drop" } },
      }),
    );
    const sha256 = createHash("sha256").update(fs.readFileSync(scriptFile)).digest("hex");
    try {
      const result = await runLane(harness.env, [
        "mock",
        "--lane",
        "candidate",
        "--script",
        scriptFile,
        sha256,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        eventFiles: 1,
        responses: 3,
        scriptSha256: sha256,
      });
      const control = JSON.parse(
        fs.readFileSync(path.join(path.dirname(harness.outputRoot), "mock-response.json"), "utf8"),
      );
      expect(control).toMatchObject({
        default: { fail: { mode: "drop" } },
        responses: [
          { chunkDelayMs: 50, text: "first" },
          { events: [{ type: "response.completed", response: {} }] },
          { fail: { status: 503 } },
        ],
        scriptVersion: expect.stringContaining(sha256),
      });
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.invocations.at(-1)).toMatchObject({
        args: {
          eventFiles: [
            { file: "turn-events.json", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
          ],
          scriptFile: "provider-script.json",
          scriptSha256: sha256,
        },
        command: "mock",
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects a provider script whose public bytes do not match its sha256", async () => {
    const harness = await setupHarness();
    const scriptFile = path.join(harness.outputRoot, "provider-script.json");
    fs.writeFileSync(scriptFile, JSON.stringify({ responses: [{ text: "first" }] }));
    try {
      await expect(
        runLane(harness.env, [
          "mock",
          "--lane",
          "candidate",
          "--script",
          scriptFile,
          "0".repeat(64),
        ]),
      ).rejects.toThrow("mock --script sha256 mismatch");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(harness.outputRoot), "mock-response.json"),
            "utf8",
          ),
        ),
      ).toEqual({ chunkDelayMs: 0, text: "initial" });
    } finally {
      await harness.close();
    }
  });

  it("programs Bot API faults and reads bounded method-filtered request facts", async () => {
    const harness = await setupHarness();
    fs.writeFileSync(
      harness.proxyRequestLog,
      [
        JSON.stringify({ method: "sendMessage", status: 429, injected: true }),
        JSON.stringify({ method: "editMessageText", status: 200, injected: false }),
        JSON.stringify({ method: "sendMessage", status: 200, injected: false }),
      ].join("\n") + "\n",
    );
    try {
      await runLane(harness.env, [
        "botapi-fail",
        "sendMessage",
        "--lane",
        "candidate",
        "--times",
        "2",
        "--status",
        "429",
      ]);
      expect(JSON.parse(fs.readFileSync(harness.proxyControl, "utf8"))).toEqual({
        rules: [{ method: "sendMessage", status: 429, times: 2 }],
      });
      const requests = await runLane(harness.env, [
        "botapi-requests",
        "--lane",
        "candidate",
        "--method",
        "sendMessage",
        "--limit",
        "1",
      ]);
      expect(JSON.parse(requests.stdout)).toEqual({
        count: 1,
        requests: [{ index: 1, injected: false, method: "sendMessage", status: 200 }],
      });
      await runLane(harness.env, ["botapi-clear", "--lane", "candidate"]);
      expect(JSON.parse(fs.readFileSync(harness.proxyControl, "utf8"))).toEqual({ rules: [] });
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(
        state.invocations.slice(-3).map((entry: { command: string }) => entry.command),
      ).toEqual(["botapi-fail", "botapi-requests", "botapi-clear"]);
    } finally {
      await harness.close();
    }
  });

  it("returns early when all observe fact conditions are satisfied", async () => {
    const harness = await setupHarness();
    fs.writeFileSync(harness.requestLog, `${JSON.stringify({ path: "/v1/responses" })}\n`);
    try {
      const startedAt = Date.now();
      const result = await runLane(harness.env, [
        "observe",
        "--lane",
        "candidate",
        "--seconds",
        "60",
        "--since",
        "0",
        "--until-events",
        "2",
        "--until-text",
        "final",
        "--until-provider-requests",
        "1",
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(JSON.parse(result.stdout)).toMatchObject({
        cursor: 2,
        events: [{ text: "draft" }, { text: "final" }],
      });
      expect(harness.requests).toEqual([{ command: "events", seconds: 0, since: 0 }]);
    } finally {
      await harness.close();
    }
  });

  it("ignores stale pre-cursor events when evaluating observe conditions", async () => {
    const harness = await setupHarness();
    try {
      const startedAt = Date.now();
      // The mock observer timeline always holds two events ("draft", "final");
      // with --since past them, a reused marker or count must not return early.
      const result = await runLane(harness.env, [
        "observe",
        "--lane",
        "candidate",
        "--seconds",
        "1",
        "--since",
        "2",
        "--until-events",
        "1",
        "--until-text",
        "final",
      ]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
      expect(JSON.parse(result.stdout)).toMatchObject({ events: [] });
      expect(harness.requests.length).toBeGreaterThan(1);
    } finally {
      await harness.close();
    }
  });

  it("serializes commands across both lanes on the shared user session", async () => {
    const harness = await setupHarness();
    fs.writeFileSync(path.join(harness.sessionRoot, "harness.lock"), `${process.pid}\n`);
    try {
      await expect(runLane(harness.env, ["requests", "--lane", "candidate"])).rejects.toThrow(
        "shared Telegram harness already has a command in progress",
      );
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects scenario flags that would otherwise be silently ignored", async () => {
    const harness = await setupHarness();
    try {
      await expect(
        runLane(harness.env, [
          "turn",
          "--lane",
          "candidate",
          "--text",
          "hello",
          "--observe-second",
          "2",
        ]),
      ).rejects.toThrow("turn does not accept --observe-second");
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("refuses to focus stale chat history outside the live proof timeline", async () => {
    const harness = await setupHarness();
    try {
      await expect(
        runLane(harness.env, ["view", "--lane", "candidate", "--message-id", "999"]),
      ).rejects.toThrow("Message 999 was not observed in this proof session");
      expect(harness.requests).toEqual([{ command: "events", seconds: 0, since: 0 }]);
    } finally {
      await harness.close();
    }
  });

  it("keeps long-running proof sessions usable", async () => {
    const harness = await setupHarness();
    const active = path.join(harness.sessionRoot, "candidate.active.json");
    const state = JSON.parse(fs.readFileSync(active, "utf8"));
    state.startedAt = "2026-01-01T00:00:00.000Z";
    state.observeSeconds = 900;
    writeJson(active, state);
    try {
      const result = await runLane(harness.env, [
        "observe",
        "--lane",
        "candidate",
        "--seconds",
        "1",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      expect(JSON.parse(fs.readFileSync(active, "utf8"))).toMatchObject({ observeSeconds: 901 });
    } finally {
      await harness.close();
    }
  });

  it("keeps later proof attempts usable", async () => {
    const harness = await setupHarness();
    const active = path.join(harness.sessionRoot, "candidate.active.json");
    const state = JSON.parse(fs.readFileSync(active, "utf8"));
    state.attempt = 4;
    writeJson(active, state);
    try {
      const result = await runLane(harness.env, ["requests", "--lane", "candidate"]);
      expect(JSON.parse(result.stdout)).toEqual({ count: 0, requests: [] });
    } finally {
      await harness.close();
    }
  });

  it("exposes provider content facts through requests and terminal lane facts", async () => {
    const harness = await setupHarness({ userOnlyEvents: true });
    const contentFacts = [
      {
        type: "input_file",
        filename: "proof.pdf",
        mimeType: "application/pdf",
        byteLength: 17,
      },
    ];
    fs.writeFileSync(
      harness.requestLog,
      `${JSON.stringify({
        seq: 1,
        body: "credential=123456:secret-sut-token",
        contentFacts,
        path: "/v1/responses",
      })}\n`,
    );
    try {
      const requests = JSON.parse(
        (await runLane(harness.env, ["requests", "--lane", "candidate"])).stdout,
      );
      expect(requests).toEqual({
        count: 1,
        requests: [
          {
            seq: 1,
            body: "credential=[redacted]",
            contentFacts,
            path: "/v1/responses",
          },
        ],
      });

      // Tail window: a session with more records than the window must expose
      // its newest requests — the ones under proof — with their absolute seq.
      fs.writeFileSync(
        harness.requestLog,
        Array.from(
          { length: 130 },
          (_, i) => `${JSON.stringify({ seq: i + 1, body: `turn ${i + 1}` })}\n`,
        ).join(""),
      );
      const tail = JSON.parse(
        (await runLane(harness.env, ["requests", "--lane", "candidate"])).stdout,
      );
      expect(tail.count).toBe(128);
      expect(tail.requests[0]).toEqual({ seq: 3, body: "turn 3" });
      expect(tail.requests.at(-1)).toEqual({ seq: 130, body: "turn 130" });

      // Restore the single-record log so terminal lane facts mirror the
      // requests assertion above.
      fs.writeFileSync(
        harness.requestLog,
        `${JSON.stringify({
          seq: 1,
          body: "credential=123456:secret-sut-token",
          contentFacts,
          path: "/v1/responses",
        })}\n`,
      );
      await runLane(harness.env, ["send", "--lane", "candidate", "--text", "persist facts"]);
      await runLane(harness.env, ["finish", "--lane", "candidate"]);
      const facts = JSON.parse(
        fs.readFileSync(
          path.join(harness.outputRoot, "candidate", "mantis-lane-facts.json"),
          "utf8",
        ),
      );
      expect(facts.providerRequests).toEqual(requests.requests);
      expect(JSON.stringify(facts.providerRequests)).not.toContain("secret-sut-token");
    } finally {
      await harness.close();
    }
  });

  it("finishes an expected-silence proof on the triggering user message", async () => {
    const harness = await setupHarness({ userOnlyEvents: true });
    try {
      await runLane(harness.env, ["send", "--lane", "candidate", "--text", "stay silent"]);
      const result = await runLane(harness.env, ["finish", "--lane", "candidate"]);
      expect(JSON.parse(result.stdout)).toEqual({
        attempt: 1,
        lane: "candidate",
        status: "complete",
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(harness.sessionRoot, "candidate.json"), "utf8")),
      ).toMatchObject({
        botApiRequests: [],
        focusMessageId: "101",
        sendCount: 1,
        status: "complete",
      });
    } finally {
      await harness.close();
    }
  });

  it("reports an unproven comparison without inventing a missing primitive", async () => {
    const harness = await setupHarness();
    try {
      const result = await runLane(harness.env, [
        "block",
        "--lane",
        "candidate",
        "--reason",
        "Baseline and candidate behaved identically.",
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        attempt: 1,
        lane: "candidate",
        status: "blocked",
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(harness.sessionRoot, "candidate.json"), "utf8")),
      ).toMatchObject({
        blocked: { reason: "Baseline and candidate behaved identically." },
        status: "blocked",
      });
    } finally {
      await harness.close();
    }
  });

  it("recovers a startup interrupted before any service launched", async () => {
    const harness = await setupHarness();
    const active = path.join(harness.sessionRoot, "candidate.active.json");
    const starting = path.join(harness.sessionRoot, "candidate.starting.json");
    fs.rmSync(active);
    writeJson(starting, {
      attempt: 1,
      lane: "candidate",
      observerPidFile: path.join(harness.sessionRoot, "observer.pid.json"),
      observerRequested: false,
      observerSocket: path.join(harness.sessionRoot, "observer.sock"),
      privateDir: harness.sessionRoot,
      recorderRequested: false,
      recorderSession: path.join(harness.sessionRoot, "desktop-recorder.json"),
      repoRoot: "/prepared/candidate",
      startedAt: new Date().toISOString(),
    });
    try {
      const result = await runLane(harness.env, ["abort", "--lane", "candidate"]);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "aborted-startup" });
      expect(fs.existsSync(starting)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("records a real turn send even when its observation fails", async () => {
    const harness = await setupHarness({ failEvents: true });
    try {
      await expect(
        runLane(harness.env, [
          "turn",
          "--lane",
          "candidate",
          "--text",
          "persist this send",
          "--observe-seconds",
          "1",
        ]),
      ).rejects.toThrow("observer failed after send");
      const state = JSON.parse(
        fs.readFileSync(path.join(harness.sessionRoot, "candidate.active.json"), "utf8"),
      );
      expect(state.sendCount).toBe(1);
      expect(state.invocations.at(-1)).toMatchObject({ command: "reveal" });
    } finally {
      await harness.close();
    }
  });
});
