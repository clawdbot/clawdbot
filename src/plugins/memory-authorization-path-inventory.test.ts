import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";
import {
  MEMORY_AUTHORIZATION_PATH_DISPOSITIONS,
  MEMORY_AUTHORIZATION_PATH_INVENTORY,
  type MemoryAuthorizationPathInventoryEntry,
} from "./memory-authorization-path-inventory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REQUIRED_PHASE_0_PATH_IDS = [
  "selected-runtime-manager-acquisition",
  "selected-runtime-backend-resolution",
  "bootstrap-memory-and-user-files",
  "startup-recent-memory-context",
  "memory-search-tool",
  "memory-get-tool",
  "session-transcript-search",
  "active-memory-trigger-recall",
  "memory-wiki-prompt-supplement-registration",
  "memory-wiki-prompt-preparation-registration",
  "memory-wiki-corpus-supplement-registration",
  "memory-wiki-agent-query-read",
  "memory-wiki-agent-mutation",
  "memory-wiki-operator-query-read",
  "memory-wiki-operator-mutation",
  "memory-wiki-bridge-artifact-read",
  "memory-wiki-bridge-artifact-import",
  "memory-wiki-status",
  "lancedb-tool-recall",
  "lancedb-tool-store",
  "lancedb-tool-forget",
  "lancedb-auto-recall",
  "lancedb-auto-capture",
  "lancedb-cli-read",
  "memory-prompt-supplements",
  "memory-prompt-preparations",
  "memory-corpus-supplements",
  "talk-fast-context",
  "project-memory-bootstrap",
  "memory-status-command",
  "memory-cli-search-and-get",
  "memory-cli-sync-and-reindex",
  "memory-doctor-inspection-and-repair",
  "gateway-memory-search",
  "memory-import",
  "memory-migration-import",
  "memory-export",
  "memory-public-artifact-provider-list",
  "generic-file-read",
  "generic-file-write",
  "generic-file-edit",
  "generic-file-apply-patch",
  "sandbox-workspace-mounts",
  "unsandboxed-exec",
  "post-compaction-session-memory-sync",
  "memory-flush",
  "transcript-event-write",
  "transcript-history-and-replay",
  "compaction-summary",
  "compaction-checkpoint",
  "compaction-checkpoint-operator-branch-and-restore",
  "dreaming-source-recall",
  "dreaming-derived-artifacts",
  "profile-and-short-term-promotion",
  "child-agent-delegation",
  "child-agent-completion-handoff",
  "cron-triggered-run",
  "heartbeat-triggered-run",
  "webhook-triggered-run",
  "system-triggered-run",
  "final-reply-delivery",
  "message-tool-delivery",
  "session-send-delivery",
  "plugin-and-mcp-outbound-actions",
] as const;

const MEMORY_MANAGER_CALL_NAMES = new Set([
  "getActiveMemorySearchManager",
  "getMemorySearchManager",
]);

const SUPPLEMENTAL_PATH_DIRECTIONS = {
  "memory-wiki-prompt-supplement-registration": "egress",
  "memory-wiki-prompt-preparation-registration": "egress",
  "memory-wiki-corpus-supplement-registration": "egress",
  "memory-wiki-agent-query-read": "egress",
  "memory-wiki-agent-mutation": "ingress",
  "memory-wiki-operator-query-read": "egress",
  "memory-wiki-operator-mutation": "ingress",
  "memory-wiki-bridge-artifact-read": "egress",
  "memory-wiki-bridge-artifact-import": "ingress",
  "lancedb-tool-recall": "egress",
  "lancedb-tool-store": "ingress",
  "lancedb-tool-forget": "ingress",
  "lancedb-auto-recall": "egress",
  "lancedb-auto-capture": "ingress",
  "lancedb-cli-read": "egress",
} as const;

const MEMORY_MIGRATION_IMPORT_ROUTE_SURFACES = [
  "src/cli/program/register.migrate.ts",
  "src/commands/migrate.ts",
  "src/commands/migrate/memory-import.ts",
  "src/commands/migrate/apply.ts",
  "extensions/migrate-claude/provider.ts",
  "extensions/migrate-claude/plan.ts",
  "extensions/migrate-claude/memory.ts",
  "extensions/migrate-claude/apply.ts",
  "extensions/migrate-hermes/provider.ts",
  "extensions/migrate-hermes/plan.ts",
  "extensions/migrate-hermes/memory.ts",
  "extensions/migrate-hermes/apply.ts",
  "extensions/codex/src/migration/provider.ts",
  "extensions/codex/src/migration/plan.ts",
  "extensions/codex/src/migration/apply.ts",
] as const;

const MEMORY_MIGRATION_IMPORT_ROOTS = [
  "src/cli/program/register.migrate.ts",
  "src/commands/migrate.ts",
  "src/commands/migrate",
  "extensions/migrate-claude",
  "extensions/migrate-hermes",
  "extensions/codex/src/migration",
] as const;

function isProductionTypeScript(file: string): boolean {
  return (
    file.endsWith(".ts") &&
    !file.endsWith(".d.ts") &&
    !file.includes(".test.") &&
    !file.includes(".spec.") &&
    !file.includes(".test-") &&
    !/(^|\/)test[-.]/u.test(file) &&
    !/(^|\/)tests?\//u.test(file)
  );
}

function listContextFreeMemoryManagerCalls(file: string, sourceText: string): string[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const callableBindings = new Set(MEMORY_MANAGER_CALL_NAMES);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || statement.importClause?.isTypeOnly || ts.isNamespaceImport(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && MEMORY_MANAGER_CALL_NAMES.has(imported)) {
        callableBindings.add(element.name.text);
      }
    }
  }
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        (ts.isIdentifier(expression) && callableBindings.has(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          MEMORY_MANAGER_CALL_NAMES.has(expression.name.text)) ||
        (ts.isElementAccessExpression(expression) &&
          expression.argumentExpression !== undefined &&
          ts.isStringLiteral(expression.argumentExpression) &&
          MEMORY_MANAGER_CALL_NAMES.has(expression.argumentExpression.text))
      ) {
        calls.push(expression.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return calls;
}

function listImportedCallBindings(source: ts.SourceFile, importedName: string): Set<string> {
  const bindings = new Set([importedName]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (
      !namedBindings ||
      statement.importClause?.isTypeOnly ||
      ts.isNamespaceImport(namedBindings)
    ) {
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && imported === importedName) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function isNamedCall(
  expression: ts.LeftHandSideExpression,
  bindings: ReadonlySet<string>,
): boolean {
  return (
    (ts.isIdentifier(expression) && bindings.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) && bindings.has(expression.name.text))
  );
}

function isMigrationProviderApplyCall(expression: ts.LeftHandSideExpression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "apply") {
    return false;
  }
  const receiver = expression.expression;
  return (
    (ts.isIdentifier(receiver) && receiver.text === "provider") ||
    (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "provider")
  );
}

function containsMemoryStringLiteral(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteral(child) && child.text === "memory") {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isMemoryKindPropertyOfMigrationItem(
  node: ts.PropertyAssignment,
  createItemBindings: ReadonlySet<string>,
): boolean {
  if (
    !ts.isIdentifier(node.name) ||
    node.name.text !== "kind" ||
    !containsMemoryStringLiteral(node.initializer)
  ) {
    return false;
  }
  const object = node.parent;
  const call = object.parent;
  return ts.isObjectLiteralExpression(object) && ts.isCallExpression(call)
    ? isNamedCall(call.expression, createItemBindings)
    : false;
}

function listMemoryMigrationIngressMarkers(file: string, sourceText: string): string[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const createItemBindings = listImportedCallBindings(source, "createMigrationItem");
  const copyMemoryBindings = listImportedCallBindings(source, "copyMemoryMigrationFileItem");
  const defaultCommandBindings = listImportedCallBindings(source, "migrateDefaultCommand");
  const applyCommandBindings = listImportedCallBindings(source, "migrateApplyCommand");
  const applyBindings = listImportedCallBindings(source, "runMigrationApply");
  const markers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      isMemoryKindPropertyOfMigrationItem(node, createItemBindings)
    ) {
      markers.push(node.getText(source));
    }
    if (ts.isCallExpression(node)) {
      if (isNamedCall(node.expression, copyMemoryBindings)) {
        markers.push(node.getText(source));
      }
      if (isNamedCall(node.expression, defaultCommandBindings)) {
        markers.push("migration-default-command-dispatch");
      }
      if (isNamedCall(node.expression, applyCommandBindings)) {
        markers.push("migration-apply-command-dispatch");
      }
      if (isNamedCall(node.expression, applyBindings)) {
        // Generic migration application admits provider plans containing memory items, so every
        // caller is an ingress route until an owning Phase records its authorization boundary.
        markers.push("migration-plan-apply");
      }
      if (isMigrationProviderApplyCall(node.expression)) {
        markers.push("migration-provider-apply");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return markers;
}

describe("memory authorization path inventory", () => {
  const inventory: readonly MemoryAuthorizationPathInventoryEntry[] =
    MEMORY_AUTHORIZATION_PATH_INVENTORY;

  it("records every required ingress and egress path with one owner and disposition", () => {
    const ids = inventory.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([...REQUIRED_PHASE_0_PATH_IDS]));
    expect(inventory.length).toBeGreaterThanOrEqual(55);
    for (const item of inventory) {
      expect(item.owner.length).toBeGreaterThan(0);
      expect(MEMORY_AUTHORIZATION_PATH_DISPOSITIONS).toContain(item.disposition);
      expect(item.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("keeps Phase 0 shadow-only and explicitly fails enforced bypasses closed", () => {
    expect(inventory.filter((item) => item.disposition === "authorized")).toEqual([]);
    expect(inventory.filter((item) => item.disposition === "operator-only-authenticated")).toEqual(
      [],
    );
    expect(inventory.some((item) => item.disposition === "legacy-only")).toBe(true);
    expect(inventory.some((item) => item.disposition === "blocked-in-enforced-mode")).toBe(true);
  });

  it("keeps supplemental reads and mutations as distinct enforced-mode paths", () => {
    const entriesById = new Map(inventory.map((item) => [item.id, item]));
    for (const [id, direction] of Object.entries(SUPPLEMENTAL_PATH_DIRECTIONS)) {
      expect(entriesById.get(id)).toMatchObject({
        direction,
        disposition: "blocked-in-enforced-mode",
      });
    }
  });

  it("keeps post-compaction session sync separate from memory-flush derivation", () => {
    const entriesById = new Map(inventory.map((item) => [item.id, item]));

    expect(entriesById.get("post-compaction-session-memory-sync")).toMatchObject({
      direction: "ingress",
      owner: "core-agent-runtime",
      disposition: "blocked-in-enforced-mode",
      surfaces: expect.arrayContaining([
        "src/agents/embedded-agent-runner/compaction-hooks.ts",
        "src/agents/embedded-agent-runner/compaction-session-execution.ts",
        "src/agents/embedded-agent-runner/compact.queued.ts",
        "src/agents/embedded-agent-runner/run/timeout-context-recovery.ts",
      ]),
    });
    expect(entriesById.get("memory-flush")).toMatchObject({
      direction: "derive",
    });
  });

  it("records the complete operator migration memory-import route", () => {
    const migrationImport = inventory.find((item) => item.id === "memory-migration-import");

    expect(migrationImport).toMatchObject({
      direction: "ingress",
      owner: "operator-memory-host",
      disposition: "blocked-in-enforced-mode",
      surfaces: expect.arrayContaining([...MEMORY_MIGRATION_IMPORT_ROUTE_SURFACES]),
    });
  });

  it("names only existing production surfaces", () => {
    const missing = inventory.flatMap((item) =>
      item.surfaces
        .filter((surface) => !fs.existsSync(path.join(REPO_ROOT, surface)))
        .map((surface) => `${item.id}:${surface}`),
    );
    expect(missing).toEqual([]);
  });

  it("finds direct and aliased context-free manager acquisition calls", () => {
    expect(
      listContextFreeMemoryManagerCalls(
        "fixture.ts",
        `
          import { getActiveMemorySearchManager as active } from "./memory-runtime.js";
          import { getMemorySearchManager as manager } from "./manager.js";
          import * as runtime from "./memory-runtime.js";
          import type { getMemorySearchManager as TypeOnly } from "./manager.js";
          interface Runtime { getMemorySearchManager(params: unknown): Promise<unknown>; }
          async function acquire(value: Runtime) {
            await active({}); await manager({}); await runtime.getActiveMemorySearchManager({});
            await value.getMemorySearchManager({}); await value["getMemorySearchManager"]({});
          }
        `,
      ),
    ).toEqual([
      "active",
      "manager",
      "runtime.getActiveMemorySearchManager",
      "value.getMemorySearchManager",
      'value["getMemorySearchManager"]',
    ]);
  });

  it("finds the generic migration provider apply consumer without matching unrelated apply calls", () => {
    expect(
      listMemoryMigrationIngressMarkers(
        "fixture.ts",
        `
          async function apply(params: { provider: { apply: Function } }, ctx: unknown) {
            await params.provider.apply(ctx, {});
            await other.apply(ctx, {});
          }
        `,
      ),
    ).toEqual(["migration-provider-apply"]);
  });

  it("finds generic migration plan application consumers that can apply memory items", () => {
    expect(
      listMemoryMigrationIngressMarkers(
        "fixture.ts",
        `
          import { runMigrationApply as apply } from "./apply.js";
          async function migrate() {
            await apply({});
            await unrelated({});
          }
        `,
      ),
    ).toEqual(["migration-plan-apply"]);
  });

  it("recognizes the generic CLI migration apply ingress", () => {
    const command = "src/cli/program/register.migrate.ts";
    const source = fs.readFileSync(path.join(REPO_ROOT, command), "utf8");

    expect(listMemoryMigrationIngressMarkers(command, source)).toEqual(
      expect.arrayContaining([
        "migration-default-command-dispatch",
        "migration-apply-command-dispatch",
      ]),
    );
  });

  it("does not treat test-only source helpers as production manager paths", () => {
    expect(
      isProductionTypeScript("extensions/memory-core/src/memory/test-manager-helpers.ts"),
    ).toBe(false);
    expect(isProductionTypeScript("extensions/memory-core/src/memory/search-manager.ts")).toBe(
      true,
    );
  });

  it("does not allow an unrecorded production context-free manager acquisition", () => {
    const tracked = listGitTrackedFiles({
      repoRoot: REPO_ROOT,
      pathspecs: ["src", "extensions", "packages"],
    });
    if (!tracked) {
      throw new Error("could not list tracked files for the authorization-path inventory");
    }
    const inventoried = new Set(inventory.flatMap((item) => item.surfaces));
    const missing = tracked
      .filter(isProductionTypeScript)
      .filter(
        (file) =>
          listContextFreeMemoryManagerCalls(
            file,
            fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
          ).length > 0,
      )
      .filter((file) => !inventoried.has(file));
    expect(missing).toEqual([]);
  });

  it("does not allow an unrecorded production migration memory-import producer or consumer", () => {
    const tracked = listGitTrackedFiles({
      repoRoot: REPO_ROOT,
      pathspecs: [...MEMORY_MIGRATION_IMPORT_ROOTS],
    });
    if (!tracked) {
      throw new Error(
        "could not list tracked files for the migration authorization-path inventory",
      );
    }
    const inventoried = new Set(inventory.flatMap((item) => item.surfaces));
    const missing = tracked
      .filter(isProductionTypeScript)
      .filter(
        (file) =>
          listMemoryMigrationIngressMarkers(
            file,
            fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
          ).length > 0,
      )
      .filter((file) => !inventoried.has(file));

    expect(missing).toEqual([]);
  });
});
