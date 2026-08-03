// Realtime Talk live producer tests cover bounded QA evidence and child status parsing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRealtimeTalkLiveCommand,
  buildRealtimeTalkLiveEvidence,
  createRealtimeTalkResultParser,
  parseRealtimeTalkLiveOptions,
  runRealtimeTalkLiveProducer,
} from "./realtime-talk-live.js";

const tempDirs: string[] = [];

async function makeOptions() {
  const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "realtime-talk-live-"));
  tempDirs.push(artifactBase);
  return {
    artifactBase,
    repoRoot: process.cwd(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("realtime Talk live QA producer", () => {
  it("builds the canonical one-cycle OpenAI-only smoke command", () => {
    const command = buildRealtimeTalkLiveCommand({ OPENAI_API_KEY: "test-key" });

    expect(command.args).toEqual([
      "--import",
      "tsx",
      "scripts/dev/realtime-talk-live-smoke.ts",
      "--openai-only",
      "--openai-audio-cycles",
      "1",
    ]);
    expect(command.env.OPENAI_API_KEY).toBe("test-key");
  });

  it("parses result prefixes across stream chunks without retaining details", () => {
    const parser = createRealtimeTalkResultParser();
    parser.append("openai-backend-bridge: o");
    parser.append("k { model: 'gpt-realtime-2.1' }\n");
    parser.append(
      "openai-backend-audio-roundtrip: ok {\n  transcripts: ['private transcript']\n}\n",
    );
    parser.append("openai-webrtc-browser: failed { error: 'private provider error' }");

    expect(Object.fromEntries(parser.finish())).toEqual({
      "openai-backend-bridge": ["ok"],
      "openai-backend-audio-roundtrip": ["ok"],
      "openai-webrtc-browser": ["failed"],
    });
  });

  it("writes blocked evidence without exposing unrelated or missing credentials", async () => {
    const options = await makeOptions();
    const runChild = vi.fn();
    const evidence = await runRealtimeTalkLiveProducer(
      options,
      { OTHER_SECRET: "do-not-record" },
      { runChild },
    );

    expect(runChild).not.toHaveBeenCalled();
    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const artifacts = JSON.stringify(evidence);
    const log = await fs.readFile(
      path.join(options.artifactBase, "realtime-talk-live.log"),
      "utf8",
    );
    expect(artifacts).not.toContain("do-not-record");
    expect(log).toContain("OPENAI_API_KEY is not set");
    expect(log).not.toContain("do-not-record");
  });

  it("records only normalized status and byte metadata for a passing smoke", async () => {
    const options = await makeOptions();
    const apiKey = "sk-private-test-key";
    const transcript = "private transcript must never persist";
    const evidence = await runRealtimeTalkLiveProducer(
      options,
      { OPENAI_API_KEY: apiKey },
      {
        runChild: async ({ onStderr, onStdout }) => {
          onStdout(`openai-backend-bridge: ok { token: '${apiKey}' }\n`);
          onStdout(`openai-backend-audio-roundtrip: ok { transcripts: ['${transcript}'] }\n`);
          onStdout("openai-webrtc-browser: ok { state: 'connected' }\n");
          onStderr("provider debug output should not persist");
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("pass");
    const log = await fs.readFile(
      path.join(options.artifactBase, "realtime-talk-live.log"),
      "utf8",
    );
    expect(log).toContain("audioFormat: pcm16le");
    expect(log).toContain("audioSampleRateHz: 24000");
    expect(log).toContain("openai-webrtc-browser=ok");
    expect(log).toMatch(/statusSha256: [a-f0-9]{64}/u);
    expect(log).not.toContain(apiKey);
    expect(log).not.toContain(transcript);
    expect(log).not.toContain("provider debug output");
    expect(JSON.stringify(evidence)).not.toContain(apiKey);
    expect(JSON.stringify(evidence)).not.toContain(transcript);
  });

  it("fails clean exits that omit an expected smoke leg", async () => {
    const options = await makeOptions();
    const evidence = await runRealtimeTalkLiveProducer(
      options,
      { OPENAI_API_KEY: "test-key" },
      {
        runChild: async ({ onStdout }) => {
          onStdout("openai-backend-bridge: ok {}\n");
          onStdout("openai-backend-audio-roundtrip: ok {}\n");
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("fail");
    expect(evidence.entries[0]?.result.failure?.reason).toContain("openai-webrtc-browser=missing");
  });

  it("reports missing Playwright as blocked harness evidence", async () => {
    const options = await makeOptions();
    const evidence = await runRealtimeTalkLiveProducer(
      options,
      { OPENAI_API_KEY: "test-key" },
      {
        runChild: async ({ onStderr }) => {
          onStderr("Executable doesn't exist. Run npx playwright install chromium.");
          return { exitCode: 1, signal: null };
        },
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("blocked");
  });

  it("keeps an observed smoke failure terminal when the harness is also blocked", async () => {
    const options = await makeOptions();
    const evidence = await runRealtimeTalkLiveProducer(
      options,
      { OPENAI_API_KEY: "test-key" },
      {
        runChild: async ({ onStderr, onStdout }) => {
          onStdout("openai-backend-bridge: failed { error: 'provider rejected session' }\n");
          onStderr("Executable doesn't exist. Run npx playwright install chromium.");
          return { exitCode: 1, signal: null };
        },
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("fail");
    expect(evidence.entries[0]?.result.failure?.reason).toContain("openai-backend-bridge=failed");
  });

  it("builds catalog-compatible evidence for the live scenario", async () => {
    const options = await makeOptions();
    const evidence = buildRealtimeTalkLiveEvidence({
      env: { OPENCLAW_QA_REF: "test-ref" },
      options,
      result: {
        details: "proof passed",
        durationMs: 10,
        status: "pass",
      },
    });

    expect(evidence.entries[0]).toMatchObject({
      test: {
        id: "openai-realtime-talk-live",
        source: { path: "test/e2e/qa-lab/media/realtime-talk-live.ts" },
      },
      result: {
        status: "pass",
        timing: { wallMs: 10 },
      },
    });
  });
});

describe("realtime Talk live QA options", () => {
  it("resolves the artifact directory from the selected repo root", () => {
    expect(
      parseRealtimeTalkLiveOptions([
        "--repo-root",
        "/tmp/openclaw",
        "--artifact-base",
        ".artifacts/qa-e2e/realtime-talk",
      ]),
    ).toEqual({
      artifactBase: "/tmp/openclaw/.artifacts/qa-e2e/realtime-talk",
      repoRoot: "/tmp/openclaw",
    });
  });

  it("requires an artifact base and rejects duplicate options", () => {
    expect(() => parseRealtimeTalkLiveOptions([])).toThrow("--artifact-base is required");
    expect(() =>
      parseRealtimeTalkLiveOptions([
        "--artifact-base",
        ".artifacts/one",
        "--artifact-base",
        ".artifacts/two",
      ]),
    ).toThrow("--artifact-base was provided more than once");
  });
});
