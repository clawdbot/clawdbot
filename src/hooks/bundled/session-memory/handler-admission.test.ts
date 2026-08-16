import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createInternalHookEvent } from "../../internal-hooks.js";

const generateSlugViaLLM = vi.hoisted(() => vi.fn());

vi.mock("../../llm-slug-generator.js", () => ({ generateSlugViaLLM }));

import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  generateSlugViaLLM.mockReset();
  await flushSessionMemoryWritesForTest();
});

describe("session-memory gateway admission", () => {
  it("keeps detached manual-reset slug generation admitted after the request returns", async () => {
    const tempDir = tempDirs.make("openclaw-session-memory-admission-");
    const sessionId = "manual-reset-session";
    const sessionKey = "agent:main:main";
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir } },
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true, llmSlug: true },
          },
        },
      },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "manual-reset-user",
        parentId: null,
        message: { role: "user", content: "Keep a descriptive memory filename" },
      },
      {
        type: "message",
        id: "manual-reset-assistant",
        parentId: "manual-reset-user",
        message: { role: "assistant", content: "I will retain the slug generation work" },
      },
    ]);
    const event = createInternalHookEvent("command", "reset", sessionKey, {
      agentId: "main",
      cfg,
      previousSessionEntry: { sessionId },
      workspaceDir: tempDir,
    });
    let subordinateClosedInsideSlug: boolean | undefined;
    generateSlugViaLLM.mockImplementationOnce(async () => {
      subordinateClosedInsideSlug = isGatewaySubordinateWorkAdmissionClosed();
      return subordinateClosedInsideSlug ? null : "admitted-slug";
    });

    await withEnvAsync(
      {
        NODE_ENV: "production",
        OPENCLAW_TEST_FAST: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      async () => {
        const admission = tryBeginGatewayRootWorkAdmission();
        expect(admission).not.toBeNull();
        await admission?.run(async () => {
          void handler(event);
          admission.release();
        });
        await flushSessionMemoryWritesForTest();

        await expect(fs.readdir(path.join(tempDir, "memory"))).resolves.toEqual([
          expect.stringMatching(/-admitted-slug\.md$/),
        ]);
      },
    );

    expect(subordinateClosedInsideSlug).toBe(false);
  });
});
