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
