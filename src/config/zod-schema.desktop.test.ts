import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { DESKTOP_FIELD_HELP, DESKTOP_FIELD_LABELS } from "./zod-schema.desktop.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema desktop config", () => {
  it("round-trips the host Labs config and rejects unknown or unsafe fields", () => {
    expect(
      OpenClawSchema.parse({
        desktop: {
          host: {
            enabled: true,
            managed: true,
            port: 5901,
            passwordFile: "/run/vnc/passwd",
          },
        },
      }).desktop,
    ).toStrictEqual({
      host: { enabled: true, managed: true, port: 5901, passwordFile: "/run/vnc/passwd" },
    });
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, port: 0 } } }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, passwordFile: "relative" } } })
        .success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({ desktop: { host: { enabled: true, manageServer: true } } })
        .success,
    ).toBe(false);
  });

  it("projects labels and help from each desktop field schema", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "desktop-metadata" });
    for (const path of [
      "desktop.host",
      "desktop.host.enabled",
      "desktop.host.managed",
      "desktop.host.port",
      "desktop.host.passwordFile",
    ]) {
      expect(DESKTOP_FIELD_LABELS[path], path).toEqual(expect.any(String));
      expect(DESKTOP_FIELD_HELP[path], path).toEqual(expect.any(String));
      expect(response.uiHints[path]?.label, path).toBe(DESKTOP_FIELD_LABELS[path]);
      expect(response.uiHints[path]?.help, path).toBe(DESKTOP_FIELD_HELP[path]);
    }
  });
});
