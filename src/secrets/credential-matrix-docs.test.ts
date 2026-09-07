import { describe, expect, it } from "vitest";
import {
  renderSecretRefCredentialMatrixJson,
  renderSecretRefCredentialSurface,
} from "./credential-matrix-docs.js";
import type { SecretRefCredentialMatrixDocument } from "./credential-matrix.js";

const SUPPORTED_START = '[//]: # "secretref-supported-list-start"';
const SUPPORTED_END = '[//]: # "secretref-supported-list-end"';
const UNSUPPORTED_START = '[//]: # "secretref-unsupported-list-start"';
const UNSUPPORTED_END = '[//]: # "secretref-unsupported-list-end"';

const matrix: SecretRefCredentialMatrixDocument = {
  version: 1,
  matrixId: "strictly-user-supplied-credentials",
  pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.',
  scope: "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.",
  excludedMutableOrRuntimeManaged: ["rotating.token", "oauth.*"],
  entries: [
    {
      id: "z-secret",
      configFile: "openclaw.json",
      path: "z.secret",
      secretShape: "secret_input",
      optIn: true,
    },
    {
      id: "a-secret",
      configFile: "openclaw.json",
      path: "a.secret",
      secretShape: "secret_input",
      optIn: true,
    },
    {
      id: "auth-profiles.api_key.key",
      configFile: "auth-profile-store",
      path: "profiles.*.key",
      refPath: "profiles.*.keyRef",
      when: { type: "api_key" },
      secretShape: "sibling_ref",
      optIn: true,
      notes: "Compatibility exception: sibling ref field remains canonical.",
    },
  ],
};

function surfaceFixture(): string {
  return [
    "# Before",
    "",
    SUPPORTED_START,
    "",
    "- `a.secret` (stale annotation that must not survive)",
    "",
    SUPPORTED_END,
    "",
    "Unrelated prose.",
    "",
    UNSUPPORTED_START,
    "",
    "- `stale.unsupported`",
    "",
    UNSUPPORTED_END,
    "",
    "# After",
    "",
  ].join("\r\n");
}

describe("SecretRef credential matrix docs", () => {
  it("renders deterministic JSON with a trailing newline", () => {
    expect(renderSecretRefCredentialMatrixJson(matrix)).toBe(
      `${JSON.stringify(matrix, null, 2)}\n`,
    );
  });

  it("replaces marked blocks from matrix metadata and preserves surrounding prose", () => {
    expect(renderSecretRefCredentialSurface(surfaceFixture(), matrix)).toBe(
      [
        "# Before",
        "",
        SUPPORTED_START,
        "",
        "- `a.secret`",
        "- `z.secret`",
        "",
        "### SQLite auth-profile targets (`secrets configure` + `secrets apply` + `secrets audit`)",
        "",
        '- `profiles.*.keyRef` (`type: "api_key"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)',
        "",
        SUPPORTED_END,
        "",
        "Unrelated prose.",
        "",
        UNSUPPORTED_START,
        "",
        "- `oauth.*`",
        "- `rotating.token`",
        "",
        UNSUPPORTED_END,
        "",
        "# After",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["missing", (surface: string) => surface.replace(SUPPORTED_END, "")],
    ["duplicated", (surface: string) => `${surface}${SUPPORTED_START}\n`],
    [
      "out of order",
      (surface: string) =>
        surface
          .replace(SUPPORTED_START, "supported-marker-placeholder")
          .replace(SUPPORTED_END, SUPPORTED_START)
          .replace("supported-marker-placeholder", SUPPORTED_END),
    ],
  ])("rejects %s generated-block markers", (_label, mutate) => {
    expect(() => renderSecretRefCredentialSurface(mutate(surfaceFixture()), matrix)).toThrow(
      /SecretRef docs marker/,
    );
  });
});
