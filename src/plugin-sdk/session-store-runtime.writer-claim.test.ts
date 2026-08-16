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
const sessionEntryKeepsLifecycleOwnerPrivate: "lifecycleRunId" extends keyof SessionEntry
  ? false
  : true = true;
const sessionEntryKeepsRecoveryOwnerPrivate: "restartRecoveryOwner" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsWriterClaimPrivate;
void sessionEntryKeepsLifecycleOwnerPrivate;
void sessionEntryKeepsRecoveryOwnerPrivate;

describe("plugin internal session projection", () => {
  it("excludes durable lifecycle and recovery owners from entries and patches", () => {
    const entry: InternalSessionEntry = {
      activeWriterRunId: "run-writer",
      lifecycleRunId: "run-lifecycle",
      model: "gpt-5.6",
      restartRecoveryOwner: "external",
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
        lifecycleRunId: "run-next-lifecycle",
        model: "gpt-5.5",
        restartRecoveryOwner: "openclaw",
      }),
    ).toEqual({ model: "gpt-5.5" });
  });
});
