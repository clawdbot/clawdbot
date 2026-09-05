// Frontmatter tests cover skill metadata parsing and validation.
import { describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  resolveSkillManifestMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("parseSkillFrontmatter", () => {
  it.each([
    {
      title: "keeps recoverable colon-rich scalar values",
      frontmatter: `---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
---`,
      expectedDescription: "Use anime style IMPORTANT: Must be kawaii",
    },
    {
      title: "keeps recoverable description values beginning with punctuation",
      frontmatter: `---
name: sample-skill
description: [Beta] Builds prereleases
---`,
      expectedDescription: "[Beta] Builds prereleases",
    },
    {
      title: "keeps recoverable description values beginning with YAML-reserved characters",
      frontmatter: `---
name: sample-skill
description: @scope/package helper
---`,
      expectedDescription: "@scope/package helper",
    },
    {
      title: "keeps recoverable description values that resemble YAML aliases",
      frontmatter: `---
name: sample-skill
description: *Experimental
---`,
      expectedDescription: "*Experimental",
    },
  ])("$title", ({ frontmatter, expectedDescription }) => {
    const parsed = parseSkillFrontmatter(frontmatter);

    expect(parsed.description).toBe(expectedDescription);
  });

  it.each([
    {
      title: "rejects malformed structured fallback values with the YAML parse error",
      frontmatter: `---
name: [broken
description: Broken skill
---`,
      expectedError: "invalid frontmatter: BAD_INDENT",
    },
    {
      title: "rejects unresolved YAML aliases",
      frontmatter: `---
name: sample-skill
description: Broken skill
metadata: *missing
---`,
      expectedError: "invalid frontmatter: YAML_EXCEPTION: Unresolved alias",
    },
    {
      title: "rejects duplicate keys after a recoverable description",
      frontmatter: `---
name: first
description: Working skill
name: second
---`,
      expectedError: "invalid frontmatter: DUPLICATE_KEY",
    },
    {
      title: "rejects invalid structured values under quoted keys",
      frontmatter: `---
name: sample-skill
description: Working skill
"metadata": *missing
---`,
      expectedError: "invalid frontmatter: YAML_EXCEPTION: Unresolved alias",
    },
    {
      title: "does not let a description alias mask a later structured alias",
      frontmatter: `---
name: sample-skill
description: *legacy
metadata: *missing
---`,
      expectedError: "invalid frontmatter: YAML_EXCEPTION: Unresolved alias",
    },
    {
      title: "does not let a colon-rich description mask a structured alias",
      frontmatter: `---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
metadata: *missing
---`,
      expectedError: "invalid frontmatter: YAML_EXCEPTION: Unresolved alias",
    },
  ])("$title", ({ frontmatter, expectedError }) => {
    expect(() => parseSkillFrontmatter(frontmatter)).toThrow(expectedError);
  });

  it("rejects indentation errors following a description", () => {
    expect(() =>
      parseSkillFrontmatter(`---
name: sample-skill
description: Working skill
\tmetadata: {}
---`),
    ).toThrow(/invalid frontmatter.*(?:TAB_AS_INDENT|BAD_INDENT)/);
  });

  it("rejects unresolved aliases under explicit YAML keys", () => {
    expect(() =>
      parseSkillFrontmatter(`---
name: sample-skill
description: Working skill
? metadata
: *missing
---`),
    ).toThrow(/invalid frontmatter.*YAML_EXCEPTION: Unresolved alias/);
  });

  it("does not recover nested description keys inside malformed metadata", () => {
    expect(() =>
      parseSkillFrontmatter(`---
name: sample-skill
description: Working skill
metadata: {
description: *missing
}
---`),
    ).toThrow(/invalid frontmatter/);
  });
});

describe("resolveSkillManifestMetadata install validation", () => {
  function resolveInstall(frontmatter: Record<string, string>) {
    return resolveSkillManifestMetadata(frontmatter)?.install;
  }

  it("accepts safe install specs", () => {
    const install = resolveInstall({
      metadata:
        '{"openclaw":{"install":[{"kind":"brew","formula":"python@3.12"},{"kind":"node","package":"@scope/pkg@1.2.3"},{"kind":"go","module":"example.com/tool/cmd@v1.2.3"},{"kind":"uv","package":"uvicorn[standard]==0.31.0"},{"kind":"download","url":"https://example.com/tool.tar.gz"}]}}',
    });
    expect(install).toEqual([
      { kind: "brew", formula: "python@3.12" },
      { kind: "node", package: "@scope/pkg@1.2.3" },
      { kind: "go", module: "example.com/tool/cmd@v1.2.3" },
      { kind: "uv", package: "uvicorn[standard]==0.31.0" },
      { kind: "download", url: "https://example.com/tool.tar.gz" },
    ]);
  });

  it("drops unsafe brew formula values", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"brew","formula":"wget --HEAD"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe npm package specs for node installers", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"node","package":"file:../malicious"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe go module specs", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"go","module":"https://evil.example/mod"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe download urls", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"download","url":"file:///tmp/payload.tgz"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("normalizes a download installer's optional SHA-256 digest", () => {
    const sha256 = "a".repeat(64);
    const install = resolveInstall({
      metadata: JSON.stringify({
        openclaw: {
          install: [
            {
              kind: "download",
              url: "https://example.com/runtime.tar.bz2",
              sha256: ` ${sha256.toUpperCase()} `,
            },
          ],
        },
      }),
    });

    expect(install).toEqual([
      { kind: "download", url: "https://example.com/runtime.tar.bz2", sha256 },
    ]);
  });

  it.each(["", "abc123", "g".repeat(64), `sha256:${"a".repeat(64)}`, 123])(
    "drops a download installer declaring an invalid SHA-256 digest (%j)",
    (sha256) => {
      const install = resolveInstall({
        metadata: JSON.stringify({
          openclaw: {
            install: [{ kind: "download", url: "https://example.com/runtime.tar.bz2", sha256 }],
          },
        }),
      });

      expect(install).toBeUndefined();
    },
  );

  it("parses Link-style YAML metadata with node install hints", () => {
    const frontmatter = parseSkillFrontmatter(`---
name: create-payment-credential
description: |
  Gets secure, one-time-use payment credentials from a Link wallet so agents can complete purchases.
allowed-tools:
  - Bash(link-cli:*)
  - Bash(npx:*)
version: 0.0.1
metadata:
  author: stripe
  url: link.com/agents
  openclaw:
    homepage: https://link.com/agents
    requires:
      bins:
        - link-cli
    install:
      - kind: node
        package: "@stripe/link-cli"
        bins: [link-cli]
user-invocable: true
---
# Creating Payment Credentials
`);

    const metadata = resolveSkillManifestMetadata(frontmatter);

    expect(frontmatter.name).toBe("create-payment-credential");
    expect(frontmatter.description).toContain("one-time-use payment credentials");
    expect(resolveSkillInvocationPolicy(frontmatter).userInvocable).toBe(true);
    expect(metadata).toEqual({
      homepage: "https://link.com/agents",
      requires: {
        bins: ["link-cli"],
        anyBins: [],
        env: [],
        config: [],
      },
      install: [
        {
          kind: "node",
          package: "@stripe/link-cli",
          bins: ["link-cli"],
        },
      ],
    });
  });
});
