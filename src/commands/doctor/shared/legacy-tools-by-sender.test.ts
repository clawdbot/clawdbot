import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  collectLegacyToolsBySenderWarnings,
  maybeRepairLegacyToolsBySenderKeys,
  scanLegacyToolsBySenderKeys,
} from "./legacy-tools-by-sender.js";

describe("doctor legacy toolsBySender helpers", () => {
  it("finds untyped legacy sender keys", () => {
    const hits = scanLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                owner: { deny: ["exec"] },
                "*": { deny: ["exec"] },
                "id:alice": { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        toolsBySenderPath: ["channels", "whatsapp", "groups", "123@g.us", "toolsBySender"],
        pathLabel: "channels.whatsapp.groups.123@g.us.toolsBySender",
        key: "owner",
        targetKey: "id:owner",
      },
    ]);
  });

  it("migrates legacy sender keys to typed id entries", () => {
    const result = maybeRepairLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                owner: { deny: ["exec"] },
                alice: { deny: ["exec"] },
                "id:owner": { allow: ["fs.read"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- channels.whatsapp.groups.123@g.us.toolsBySender: migrated 1 legacy key to typed id: entries (owner (kept existing id:owner), alice -> id:alice).",
      "- channels.whatsapp.groups.123@g.us.toolsBySender: removed 1 legacy key where typed id: entries already existed.",
    ]);
    expect(result.config.channels?.whatsapp?.groups?.["123@g.us"]?.toolsBySender).toEqual({
      "id:owner": { allow: ["fs.read"] },
      "id:alice": { deny: ["exec"] },
    });
  });

  it("formats legacy sender key warnings", () => {
    const warnings = collectLegacyToolsBySenderWarnings({
      hits: [
        {
          toolsBySenderPath: ["channels", "whatsapp", "groups", "123@g.us", "toolsBySender"],
          pathLabel: "channels.whatsapp.groups.123@g.us.toolsBySender",
          key: "owner",
          targetKey: "id:owner",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "- Found 1 legacy untyped toolsBySender key (for example channels.whatsapp.groups.123@g.us.toolsBySender.owner).",
      "- Untyped sender keys are deprecated; use explicit prefixes (id:, e164:, username:, name:).",
      '- Run "openclaw doctor --fix" to migrate legacy keys to typed id: entries.',
    ]);
  });
});
