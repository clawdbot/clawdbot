import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";

describe("resolveHeartbeatVisibility", () => {
  it("returns default values when no config is provided", () => {
    const cfg = {} as ClawdbotConfig;
    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
  });

  it("uses channel defaults when provided", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: true,
            showAlerts: false,
            useIndicator: false,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: false,
    });
  });

  it("per-channel config overrides channel defaults", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
            showAlerts: true,
            useIndicator: true,
          },
        },
        telegram: {
          heartbeat: {
            showOk: true,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showOk: true,
      showAlerts: true,
      useIndicator: true,
    });
  });

  it("per-account config overrides per-channel config", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
            showAlerts: true,
            useIndicator: true,
          },
        },
        telegram: {
          heartbeat: {
            showOk: false,
            showAlerts: false,
          },
          accounts: {
            primary: {
              heartbeat: {
                showOk: true,
                showAlerts: true,
              },
            },
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({
      cfg,
      channel: "telegram",
      accountId: "primary",
    });

    expect(result).toEqual({
      showOk: true,
      showAlerts: true,
      useIndicator: true,
    });
  });

  it("falls through to defaults when account has no heartbeat config", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
          },
        },
        telegram: {
          heartbeat: {
            showAlerts: false,
          },
          accounts: {
            primary: {},
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({
      cfg,
      channel: "telegram",
      accountId: "primary",
    });

    expect(result).toEqual({
      showOk: false,
      showAlerts: false,
      useIndicator: true,
    });
  });

  it("handles missing accountId gracefully", () => {
    const cfg = {
      channels: {
        telegram: {
          heartbeat: {
            showOk: true,
          },
          accounts: {
            primary: {
              heartbeat: {
                showOk: false,
              },
            },
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result.showOk).toBe(true);
  });

  it("handles non-existent account gracefully", () => {
    const cfg = {
      channels: {
        telegram: {
          heartbeat: {
            showOk: true,
          },
          accounts: {
            primary: {
              heartbeat: {
                showOk: false,
              },
            },
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({
      cfg,
      channel: "telegram",
      accountId: "nonexistent",
    });

    expect(result.showOk).toBe(true);
  });

  it("works with whatsapp channel", () => {
    const cfg = {
      channels: {
        whatsapp: {
          heartbeat: {
            showOk: true,
            showAlerts: false,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "whatsapp" });

    expect(result).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: true,
    });
  });

  it("works with discord channel", () => {
    const cfg = {
      channels: {
        discord: {
          heartbeat: {
            useIndicator: false,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "discord" });

    expect(result).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: false,
    });
  });

  it("works with slack channel", () => {
    const cfg = {
      channels: {
        slack: {
          heartbeat: {
            showOk: true,
            showAlerts: true,
            useIndicator: true,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "slack" });

    expect(result).toEqual({
      showOk: true,
      showAlerts: true,
      useIndicator: true,
    });
  });

  it("webchat uses channel defaults only (no per-channel config)", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: true,
            showAlerts: false,
            useIndicator: false,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "webchat" });

    expect(result).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: false,
    });
  });

  it("webchat returns defaults when no channel defaults configured", () => {
    const cfg = {} as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "webchat" });

    expect(result).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
  });

  it("webchat ignores accountId (only uses defaults)", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: true,
          },
        },
      },
    } as ClawdbotConfig;

    const result = resolveHeartbeatVisibility({
      cfg,
      channel: "webchat",
      accountId: "some-account",
    });

    expect(result.showOk).toBe(true);
  });
});
