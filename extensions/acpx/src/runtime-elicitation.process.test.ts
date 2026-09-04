import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

it("round-trips codex-acp request_user_input through real processes without empty answers", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-elicitation-"));
  temporaryDirectories.push(stateDir);
  const codexAcpPath = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp");
  const appServerPath = path.resolve("extensions/acpx/test/fixtures/codex-app-server.mjs");
  vi.stubEnv("CODEX_PATH", appServerPath);
  const runtime = new AcpxRuntime({
    cwd: process.cwd(),
    sessionStore: createFileSessionStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { codex: [process.execPath, codexAcpPath] },
    }),
    permissionMode: "deny-all",
    elicitationModes: ["form", "url"],
    timeoutMs: 5_000,
  });
  const handle = await runtime.ensureSession({
    sessionKey: "agent:elicitation:acp:process",
    agent: "codex",
    mode: "oneshot",
  });
  const onElicitation = vi.fn(async (_request, context) => {
    expect(context.requestId).not.toBeUndefined();
    expect(context.signal.aborted).toBe(false);
    return { action: "accept" as const, content: { question: "round-trip" } };
  });
  const text: string[] = [];

  try {
    for await (const event of runtime.runTurn({
      handle,
      text: "ask",
      mode: "prompt",
      requestId: "process-turn",
      onElicitation,
    })) {
      if (event.type === "text_delta") {
        text.push(event.text);
      }
    }
  } finally {
    await runtime.close({ handle, reason: "test-complete" });
  }

  expect(onElicitation).toHaveBeenCalledOnce();
  expect(text.join("")).toContain('"answers":{"question":{"answers":["round-trip"]}}');
  expect(text.join("")).not.toContain('"answers":{}');
});
