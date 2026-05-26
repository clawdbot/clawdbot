import { describe, expect, it } from "vitest";
import { imessageDoctor } from "./doctor.js";

describe("imessageDoctor.collectPreviewWarnings", () => {
  it("flags accounts that share the local Messages source", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              "swang430-gmail-com": {},
              default: {},
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toHaveLength(1);
    const warning = warnings?.[0] ?? "";
    expect(warning).toContain(
      'channels.imessage: accounts "swang430-gmail-com" and "default" watch the same local Messages source (cliPath=imsg).',
    );
    expect(warning).toContain('OpenClaw runs one watcher (owner: "swang430-gmail-com")');
    expect(warning).toContain("idles the duplicate");
    expect(warning).toContain('accountId="swang430-gmail-com"');
    expect(warning).toContain('"default"');
    expect(warning).toContain('set "enabled": false');
  });

  it("includes dbPath in the warning when configured", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              primary: { cliPath: "imsg", dbPath: "/Users/me/chat.db" },
              default: { cliPath: "imsg", dbPath: "/Users/me/chat.db" },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toMatch(/cliPath=imsg, dbPath=\/Users\/me\/chat\.db/);
  });

  it("stays quiet when each enabled account targets a distinct source", async () => {
    const warnings = await imessageDoctor.collectPreviewWarnings?.({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: { cliPath: "/usr/local/bin/imsg-work" },
              home: { cliPath: "/usr/local/bin/imsg-home" },
            },
          },
        },
      } as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([]);
  });
});
