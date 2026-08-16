import { describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
} from "./session-store-runtime-internal.js";
import type { SessionEntry } from "./session-store-runtime.js";

const sessionEntryKeepsWriterClaimPrivate: "activeWriterRunId" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsWriterClaimPrivate;
const sessionEntryKeepsBaselineClaimPrivate: "sessionDiffBaselineCapture" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsBaselineClaimPrivate;

describe("plugin session writer claim projection", () => {
  it("excludes the durable writer claim from entries and patches", () => {
    const entry: InternalSessionEntry = {
      activeWriterRunId: "run-writer",
      lifecycleRunId: "run-lifecycle",
      sessionDiffBaselineCapture: {
        version: 1,
        captureId: "capture-writer",
        status: "pending",
      },
      model: "gpt-5.6",
      sessionId: "session-writer",
      updatedAt: 10,
    };

    expect(projectPluginSessionEntry(entry)).toEqual({
      model: "gpt-5.6",
      sessionId: "session-writer",
      updatedAt: 10,
    });
    expect(
      projectPluginSessionEntryPatch({
        activeWriterRunId: "run-next",
        lifecycleRunId: "run-lifecycle-next",
        sessionDiffBaselineCapture: {
          version: 1,
          captureId: "capture-next",
          status: "pending",
        },
        model: "gpt-5.5",
      }),
    ).toEqual({ model: "gpt-5.5" });
  });
});
