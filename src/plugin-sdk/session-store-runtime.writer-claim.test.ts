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

describe("plugin session writer claim projection", () => {
  it("excludes the durable writer claim from entries and patches", () => {
    const entry: InternalSessionEntry = {
      activeWriterRunId: "run-writer",
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
      projectPluginSessionEntryPatch({ activeWriterRunId: "run-next", model: "gpt-5.5" }),
    ).toEqual({ model: "gpt-5.5" });
  });
});
