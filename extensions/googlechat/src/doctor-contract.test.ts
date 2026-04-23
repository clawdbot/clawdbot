import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("googlechat doctor contract", () => {
  it("removes legacy streamMode keys", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            streamMode: "append",
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Removed channels.googlechat.streamMode (legacy key no longer used).",
      "Removed channels.googlechat.accounts.work.streamMode (legacy key no longer used).",
    ]);
    expect(result.config.channels?.googlechat).toEqual({
      accounts: {
        work: {},
      },
    });
  });

  it("moves legacy group allow toggles into enabled", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
              "spaces/bbb": {
                allow: true,
                enabled: false,
              },
            },
            accounts: {
              work: {
                groups: {
                  "spaces/ccc": {
                    allow: true,
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.googlechat.groups.spaces/aaa.allow → channels.googlechat.groups.spaces/aaa.enabled.",
      "Removed channels.googlechat.groups.spaces/bbb.allow (channels.googlechat.groups.spaces/bbb.enabled already set).",
      "Moved channels.googlechat.accounts.work.groups.spaces/ccc.allow → channels.googlechat.accounts.work.groups.spaces/ccc.enabled.",
    ]);
    expect(result.config.channels?.googlechat?.groups?.["spaces/aaa"]).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.googlechat?.groups?.["spaces/bbb"]).toEqual({
      enabled: false,
    });
    expect(result.config.channels?.googlechat?.accounts?.work?.groups?.["spaces/ccc"]).toEqual({
      enabled: true,
    });
  });
});
