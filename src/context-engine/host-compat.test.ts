// Context engine host compatibility tests cover host API compatibility behavior.
import { describe, expect, it } from "vitest";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  evaluateContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "./host-compat.js";
import type { ContextEngine, ContextEngineHostCapability } from "./types.js";

function createEngine(requiredCapabilities: ContextEngineHostCapability[]): ContextEngine {
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities,
          unsupportedMessage:
            "Use the native Codex or OpenClaw embedded runtime, or switch contextEngine to legacy.",
        },
      },
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

describe("context engine host compatibility", () => {
  it("allows engines with no host requirements", () => {
    assertContextEngineHostSupport({
      contextEngine: createEngine([]),
      operation: "agent-run",
      host: buildGenericCliContextEngineHostSupport({ backendId: "claude-cli" }),
    });
  });

  it("rejects generic CLI hosts when an engine requires pre-prompt assembly", () => {
    expect(() =>
      assertContextEngineHostSupport({
        contextEngine: createEngine(["assemble-before-prompt"]),
        operation: "agent-run",
        host: buildGenericCliContextEngineHostSupport({ backendId: "claude-cli" }),
      }),
    ).toThrow(
      'Context engine "lossless-claw" cannot run operation "agent-run" on CLI backend "claude-cli".',
    );
  });

  it("evaluates missing capabilities without throwing", () => {
    const evaluation = evaluateContextEngineHostSupport({
      contextEngineInfo: createEngine(["assemble-before-prompt"]).info,
      operation: "agent-run",
      host: buildGenericCliContextEngineHostSupport({ backendId: "claude-cli" }),
    });

    expect(evaluation).toMatchObject({
      ok: false,
      missingCapabilities: ["assemble-before-prompt"],
    });
  });

  it("allows native Codex and OpenClaw embedded hosts to satisfy pre-prompt assembly", () => {
    const engine = createEngine(["assemble-before-prompt"]);

    assertContextEngineHostSupport({
      contextEngine: engine,
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
    assertContextEngineHostSupport({
      contextEngine: engine,
      operation: "agent-run",
      host: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
    });
  });

  it("allows native Codex to satisfy thread bootstrap projection", () => {
    assertContextEngineHostSupport({
      contextEngine: createEngine(["assemble-before-prompt", "thread-bootstrap-projection"]),
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
  });
});
