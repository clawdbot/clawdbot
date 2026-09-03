import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../test-helpers/state-dir-env.js";
import { auditDocsConfigExamples } from "./docs-config-examples.js";
import { resolveRepoBundledPluginEnv } from "./repo-bundled-plugin-env.js";

type SkipStat = "skippedFragment" | "skippedNonObject" | "skippedOptOut" | "skippedParseFailure";

function auditMarkdown(markdown: string): ReturnType<typeof auditDocsConfigExamples> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-config-"));
  const docsRoot = path.join(repoRoot, "docs");
  fs.mkdirSync(docsRoot);
  fs.writeFileSync(path.join(docsRoot, "fixture.md"), markdown);
  try {
    return auditDocsConfigExamples({ repoRoot });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe("docs config examples", () => {
  it.each([
    {
      name: "reports a retired nested key in a whole config",
      markdown: "```json5\n{ agents: { defaults: { promptOverlays: {} } } }\n```",
      findings: 1,
      skipped: undefined,
      issuePath: "agents.defaults",
    },
    {
      name: "reports a retired key in an indented MDX component fence",
      markdown: [
        '<Accordion title="Legacy roster">',
        "    ```json5",
        '    { agents: { list: [{ id: "main" }] } }',
        "    ````",
        "</Accordion>",
      ].join("\n"),
      findings: 1,
      skipped: undefined,
      issuePath: "agents",
    },
    {
      name: "skips a fragment without a recognized-key majority",
      markdown: "```json5\n{ agents: {}, payloads: [] }\n```",
      findings: 0,
      skipped: "skippedFragment" as SkipStat,
    },
    {
      name: "skips an explicit opt-out",
      markdown:
        '```json5 title="legacy config" validate=false\n{ agents: { defaults: { promptOverlays: {} } } }\n```',
      findings: 0,
      skipped: "skippedOptOut" as SkipStat,
    },
    {
      name: "skips invalid JSON5",
      markdown: "```json5\n{ agents: {\n```",
      findings: 0,
      skipped: "skippedParseFailure" as SkipStat,
    },
    {
      name: "validates JSON fences",
      markdown: '```json\n{ "gateway": { "port": 18789 } }\n```',
      findings: 0,
      skipped: undefined,
    },
    {
      name: "validates JSONC tilde fences",
      markdown: '~~~JSONC\n{ // comment\n  "gateway": { "port": 18789 }\n}\n~~~',
      findings: 0,
      skipped: undefined,
    },
    {
      name: "skips arrays",
      markdown: "```json5\n[{ gateway: {} }]\n```",
      findings: 0,
      skipped: "skippedNonObject" as SkipStat,
    },
    {
      name: "reports a retired root key beside a recognized key",
      markdown: "```json5\n{ agents: {}, gateway: {}, promptOverlays: {} }\n```",
      findings: 1,
      skipped: undefined,
      issuePath: "",
    },
    {
      name: "reports a retired bundled channel key",
      markdown: '```json5\n{ channels: { slack: { identity: "bot" } } }\n```',
      findings: 1,
      skipped: undefined,
      issuePath: "channels.slack",
    },
    {
      name: "reports an unsupported OpenAI plugin config key",
      markdown:
        '```json5\n{ plugins: { entries: { openai: { config: { personalityy: "friendly" } } } } }\n```',
      findings: 1,
      skipped: undefined,
      issuePath: "plugins.entries.openai.config",
    },
    {
      name: "accepts a supported OpenAI plugin config value",
      markdown:
        '```json5\n{ plugins: { entries: { openai: { config: { personality: "off" } } } } }\n```',
      findings: 0,
      skipped: undefined,
    },
    {
      name: "drops nested include directives before validation",
      markdown:
        '```json5\n{ agents: { $include: "./agents.json5" }, gateway: { port: 18789 } }\n```',
      findings: 0,
      skipped: undefined,
    },
  ])("$name", ({ markdown, findings, skipped, issuePath }) => {
    const audit = auditMarkdown(markdown);

    expect(audit.findings).toHaveLength(findings);
    expect(audit.stats.candidatesValidated).toBe(skipped ? 0 : 1);
    if (skipped) {
      expect(audit.stats[skipped]).toBe(1);
    }
    if (issuePath !== undefined) {
      expect(audit.findings[0]?.issuePath).toBe(issuePath);
    }
  });

  it("validates plugin-owned keys without opening the operator state database", () => {
    const poisonedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-config-poison-"));
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: poisonedRoot,
    });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    } finally {
      database.close();
    }
    const envSnapshot = snapshotStateDirEnv();
    setStateDirEnv(poisonedRoot);
    try {
      const audit = auditMarkdown(
        '```json5\n{ plugins: { entries: { openai: { config: { personalityy: "friendly" } } } } }\n```',
      );
      expect(audit.findings).toHaveLength(1);
      expect(audit.findings[0]?.issuePath).toBe("plugins.entries.openai.config");
      expect(fs.existsSync(resolveRepoBundledPluginEnv("unused").OPENCLAW_STATE_DIR!)).toBe(false);
    } finally {
      restoreStateDirEnv(envSnapshot);
      fs.rmSync(poisonedRoot, { recursive: true, force: true });
    }
  });

  it("keeps real docs aligned with the config schema", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    // This test is selected when src/config changes, so retiring a key checks docs even
    // without a docs edit. The check:docs script covers docs-only PRs; together the two
    // CI lanes leave no change-classification gap.
    expect(auditDocsConfigExamples({ repoRoot }).findings).toEqual([]);
  });
});
