import { afterEach, describe, expect, it } from "vitest";
import {
  drainSystemEvents,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  enqueueConfigRecoveryNotice,
  formatConfigRecoveryNotice,
} from "./config-recovery-notice.js";

describe("config recovery notice", () => {
  afterEach(() => {
    resetSystemEventsForTest();
  });

  it("formats a prompt-facing warning for recovered configs", () => {
    expect(
      formatConfigRecoveryNotice({
        phase: "startup",
        reason: "startup-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
      }),
    ).toBe(
      "Config recovery warning: OpenClaw restored openclaw.json from the last-known-good backup during startup (startup-invalid-config). The rejected config was invalid and was preserved as a timestamped .clobbered.* file. Do not write openclaw.json again unless you validate the full config first.",
    );
  });

  it("includes rejected validation details when available", () => {
    expect(
      formatConfigRecoveryNotice({
        phase: "startup",
        reason: "startup-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
        issues: [
          { path: "agents.defaults.execution", message: "Unrecognized key: execution" },
          { path: "gateway.auth.password.source", message: "Required" },
        ],
      }),
    ).toContain(
      "Rejected validation details: agents.defaults.execution: Unrecognized key: execution; gateway.auth.password.source: Required.",
    );
  });

  it("queues the notice for the main agent session", () => {
    expect(
      enqueueConfigRecoveryNotice({
        cfg: {},
        phase: "reload",
        reason: "reload-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
        issues: [{ path: "gateway.mode", message: "Expected string" }],
      }),
    ).toBe(true);

    expect(peekSystemEvents("agent:main:main")).toHaveLength(1);
    const notice = drainSystemEvents("agent:main:main")[0];
    expect(notice).toContain("gateway.mode: Expected string");
    expect(notice).toContain(
      "Do not write openclaw.json again unless you validate the full config first.",
    );
  });
});
