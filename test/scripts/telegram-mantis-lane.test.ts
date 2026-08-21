import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishableRecorderArtifacts,
  publishStartupFailure,
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
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(sessionRoot);
  fs.mkdirSync(binDir);
  writeJson(credentialFile, {
    groupId: "-100123456789",
    sutToken: "123456:secret-sut-token",
    testerUserId: "77",
  });
  writeJson(path.join(root, "mock-response.json"), { chunkDelayMs: 0, text: "initial" });
  fs.writeFileSync(
    screenshot,
    Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(10_001)]),
  );
  fs.writeFileSync(previewGif, Buffer.alloc(10_001));
  fs.writeFileSync(trimmedVideo, Buffer.alloc(10_001));
  fs.writeFileSync(
    recorderCommand,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(recorderLog)}\ncp ${JSON.stringify(path.join(root, "mock-response.json"))} ${JSON.stringify(recorderControlLog)}\n${options.failRecorder ? "exit 1\n" : ""}if [ "$1" = artifacts ]; then\n  printf '%s\\n' ${JSON.stringify(JSON.stringify({ artifacts: { previewGifCropped: previewGif, screenshot, trimmedVideoCropped: trimmedVideo } }))}\nfi\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(userDriverCommand, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "sudo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
    recorderSession: path.join(sessionRoot, "attempt", "recorder.json"),
    repoRoot: "/prepared/candidate",
    sendCount: 0,
    startedAt: new Date().toISOString(),
    sut: {
      containerName: "openclaw-telegram-sut-test",
      gatewayLog: path.join(root, "gateway.log"),
      mockLog: path.join(root, "mock.log"),
      mockResponseControl: path.join(root, "mock-response.json"),
      requestLog: path.join(root, "requests.ndjson"),
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
    recorderControlLog,
    recorderLog,
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
        recorderSession: path.join(sessionRoot, "attempts", "candidate", "1", "recorder.json"),
        repoRoot: "/prepared/candidate",
        startedAt,
      },
      sutAttestation: { lane: "candidate", sha: "a".repeat(40) },
    });

    const facts = JSON.parse(fs.readFileSync(path.join(sessionRoot, "candidate.json"), "utf8"));
    expect(facts).toMatchObject({
      artifacts: {},
      attempt: 1,
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
        "view --session attempt/recorder.json --message-id 101",
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
      ).toMatchObject({ focusMessageId: "101", sendCount: 1, status: "complete" });
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
      recorderSession: path.join(harness.sessionRoot, "recorder.json"),
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
