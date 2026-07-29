// Frontmatter tests cover skill metadata parsing and validation.
import { describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
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

describe("parseFrontmatter", () => {
  it("keeps recoverable colon-rich scalar values", () => {
    const frontmatter = parseFrontmatter(`---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
---`);

    expect(frontmatter.description).toBe("Use anime style IMPORTANT: Must be kawaii");
  });

  it("keeps recoverable description values beginning with punctuation", () => {
    const frontmatter = parseFrontmatter(`---
name: sample-skill
description: [Beta] Builds prereleases
---`);

    expect(frontmatter.description).toBe("[Beta] Builds prereleases");
  });

  it("keeps recoverable description values beginning with YAML-reserved characters", () => {
    const frontmatter = parseFrontmatter(`---
name: sample-skill
description: @scope/package helper
---`);

    expect(frontmatter.description).toBe("@scope/package helper");
  });

  it("keeps recoverable description values that resemble YAML aliases", () => {
    const frontmatter = parseFrontmatter(`---
name: sample-skill
description: *Experimental
---`);

    expect(frontmatter.description).toBe("*Experimental");
  });

  it("rejects malformed structured fallback values with the YAML parse error", () => {
    expect(() =>
      parseFrontmatter(`---
name: [broken
description: Broken skill
---`),
    ).toThrow("invalid frontmatter: BAD_INDENT");
  });

  it("rejects unresolved YAML aliases", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Broken skill
metadata: *missing
---`),
    ).toThrow("invalid frontmatter: YAML_EXCEPTION: Unresolved alias");
  });

  it("rejects duplicate keys after a recoverable description", () => {
    expect(() =>
      parseFrontmatter(`---
name: first
description: Working skill
name: second
---`),
    ).toThrow("invalid frontmatter: DUPLICATE_KEY");
  });

  it("rejects invalid structured values under quoted keys", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Working skill
"metadata": *missing
---`),
    ).toThrow("invalid frontmatter: YAML_EXCEPTION: Unresolved alias");
  });

  it("does not let a description alias mask a later structured alias", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: *legacy
metadata: *missing
---`),
    ).toThrow("invalid frontmatter: YAML_EXCEPTION: Unresolved alias");
  });

  it("does not let a colon-rich description mask a structured alias", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Use anime style IMPORTANT: Must be kawaii
metadata: *missing
---`),
    ).toThrow("invalid frontmatter: YAML_EXCEPTION: Unresolved alias");
  });

  it("rejects indentation errors following a description", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Working skill
\tmetadata: {}
---`),
    ).toThrow(/invalid frontmatter.*(?:TAB_AS_INDENT|BAD_INDENT)/);
  });

  it("rejects unresolved aliases under explicit YAML keys", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Working skill
? metadata
: *missing
---`),
    ).toThrow(/invalid frontmatter.*YAML_EXCEPTION: Unresolved alias/);
  });

  it("does not recover nested description keys inside malformed metadata", () => {
    expect(() =>
      parseFrontmatter(`---
name: sample-skill
description: Working skill
metadata: {
description: *missing
}
---`),
    ).toThrow(/invalid frontmatter/);
  });
});

describe("resolveOpenClawMetadata install validation", () => {
  function resolveInstall(frontmatter: Record<string, string>) {
    return resolveOpenClawMetadata(frontmatter)?.install;
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

  it("parses Link-style YAML metadata with node install hints", () => {
    const frontmatter = parseFrontmatter(`---
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

    const metadata = resolveOpenClawMetadata(frontmatter);

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
