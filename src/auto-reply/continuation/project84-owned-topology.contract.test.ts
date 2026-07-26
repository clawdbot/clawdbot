import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const MONITORED_MODULES = [
  "src/agents/openclaw-tools.ts",
  "src/agents/openclaw-tools.continuation.ts",
  "src/agents/subagent-announce.ts",
  "src/agents/subagent-announce.continuation.runtime.ts",
  "src/agents/subagent-announce.continuation.accounting.ts",
  "src/agents/subagent-announce.continuation-return.ts",
  "src/process/command-queue.ts",
  "src/process/command-queue-waiters.ts",
  "src/auto-reply/reply/agent-runner-embedded-candidate.ts",
  "src/auto-reply/reply/agent-runner-post-compaction-release.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/gateway/server-methods/sessions-compact.ts",
  "src/auto-reply/continuation/work-store.ts",
  "src/auto-reply/continuation/work-flow-state.ts",
  "src/auto-reply/continuation/delegate-store.ts",
  "src/auto-reply/continuation/delegate-flow-store.ts",
  "src/auto-reply/continuation/work-dispatch.ts",
  "src/auto-reply/continuation/work-dispatch-execution.ts",
  "src/auto-reply/reply/post-compaction-delegate-dispatch.ts",
  "src/auto-reply/reply/post-compaction-delegate-delivery.ts",
  "src/gateway/server-restart-sentinel.ts",
  "src/gateway/server-restart-sentinel-delivery.ts",
  "src/auto-reply/continuation/delegate-dispatch.ts",
  "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
  "src/auto-reply/continuation/post-compaction-staged-dispatch.ts",
  "src/auto-reply/continuation/post-compaction-release.ts",
  "src/gateway/server-runtime-services.ts",
] as const;

type MonitoredModule = (typeof MONITORED_MODULES)[number];
type EdgeKind = "dynamic-import" | "import-type" | "static-export" | "static-import";
type OwnershipEdge = Readonly<{
  from: MonitoredModule;
  kind: EdgeKind;
  to: MonitoredModule;
}>;
type ScanResult = Readonly<{
  definitions: ReadonlyMap<string, readonly MonitoredModule[]>;
  edges: readonly OwnershipEdge[];
  unresolvedDynamicImports: readonly string[];
}>;

const monitoredModuleSet = new Set<string>(MONITORED_MODULES);

function resolveStaticString(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return resolveStaticString(expression.expression);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return resolveStaticString(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveStaticString(expression.left);
    const right = resolveStaticString(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = resolveStaticString(span.expression);
      if (substitution === undefined) {
        return undefined;
      }
      value += substitution + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function resolveImportTypeString(node: ts.ImportTypeNode): string | undefined {
  return ts.isLiteralTypeNode(node.argument)
    ? resolveStaticString(node.argument.literal)
    : undefined;
}

function resolveMonitoredModule(
  from: MonitoredModule,
  specifier: string,
): MonitoredModule | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const sourceModule = resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
  return monitoredModuleSet.has(sourceModule) ? (sourceModule as MonitoredModule) : undefined;
}

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function scanOwnedTopology(): ScanResult {
  const edges: OwnershipEdge[] = [];
  const definitionOwners = new Map<string, MonitoredModule[]>();
  const unresolvedDynamicImports: string[] = [];

  for (const from of MONITORED_MODULES) {
    const sourceFile = ts.createSourceFile(
      from,
      readFileSync(path.resolve(REPO_ROOT, from), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const recordEdge = (specifier: string, kind: EdgeKind): void => {
      const to = resolveMonitoredModule(from, specifier);
      if (to) {
        edges.push({ from, kind, to });
      }
    };
    const recordDefinition = (node: ts.Node): void => {
      const name = declarationName(node);
      if (name) {
        definitionOwners.set(name, [...(definitionOwners.get(name) ?? []), from]);
      }
    };
    const recordDynamicImport = (node: ts.CallExpression): void => {
      const argument = node.arguments[0];
      const specifier = argument ? resolveStaticString(argument) : undefined;
      if (specifier === undefined) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        unresolvedDynamicImports.push(`${from}:${line + 1}:${character + 1}`);
        return;
      }
      recordEdge(specifier, "dynamic-import");
    };
    const visit = (node: ts.Node): void => {
      recordDefinition(node);
      if (ts.isImportDeclaration(node)) {
        const specifier = resolveStaticString(node.moduleSpecifier);
        if (specifier !== undefined) {
          recordEdge(specifier, "static-import");
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const specifier = resolveStaticString(node.moduleSpecifier);
        if (specifier !== undefined) {
          recordEdge(specifier, "static-export");
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        recordDynamicImport(node);
      } else if (ts.isImportTypeNode(node)) {
        const specifier = resolveImportTypeString(node);
        if (specifier !== undefined) {
          recordEdge(specifier, "import-type");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    definitions: definitionOwners,
    edges: edges.toSorted((left, right) =>
      `${left.from}\0${left.to}\0${left.kind}`.localeCompare(
        `${right.from}\0${right.to}\0${right.kind}`,
      ),
    ),
    unresolvedDynamicImports: unresolvedDynamicImports.toSorted(),
  };
}

function edgeKinds(
  edges: readonly OwnershipEdge[],
  from: MonitoredModule,
  to: MonitoredModule,
): EdgeKind[] {
  return edges
    .filter((edge) => edge.from === from && edge.to === to)
    .map((edge) => edge.kind)
    .toSorted();
}

function formatObservedEdges(edges: readonly OwnershipEdge[]): string {
  return edges.map((edge) => `${edge.from} -[${edge.kind}]-> ${edge.to}`).join("\n");
}

describe("Project 84 owned topology contract", () => {
  const scan = scanOwnedTopology();
  const observedEdges = formatObservedEdges(scan.edges);

  function expectEdge(
    from: MonitoredModule,
    to: MonitoredModule,
    kind: EdgeKind = "static-import",
  ): void {
    expect(
      edgeKinds(scan.edges, from, to),
      `expected ${from} -[${kind}]-> ${to}\nObserved owned edges:\n${observedEdges}`,
    ).toEqual([kind]);
  }

  function expectNoEdge(from: MonitoredModule, to: MonitoredModule): void {
    expect(
      edgeKinds(scan.edges, from, to),
      `forbidden ${from} -> ${to}\nObserved owned edges:\n${observedEdges}`,
    ).toEqual([]);
  }

  it("resolves every dynamic import in monitored owner and caller files", () => {
    expect(scan.unresolvedDynamicImports).toEqual([]);
  });

  it("keeps Card 1 work state below the canonical store", () => {
    expectEdge(
      "src/auto-reply/continuation/work-store.ts",
      "src/auto-reply/continuation/work-flow-state.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/work-flow-state.ts",
      "src/auto-reply/continuation/work-store.ts",
    );
  });

  it("keeps Card 2 delegate records below the canonical store without the deleted facade", () => {
    expectEdge(
      "src/auto-reply/continuation/delegate-store.ts",
      "src/auto-reply/continuation/delegate-flow-store.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/delegate-flow-store.ts",
      "src/auto-reply/continuation/delegate-store.ts",
    );
    expect(
      existsSync(path.resolve(REPO_ROOT, "src/auto-reply/continuation-delegate-store.ts")),
      "deleted continuation-delegate-store.ts compatibility facade must stay absent",
    ).toBe(false);
  });

  it("keeps Card 3 execution below lifecycle with one registry accessor declaration", () => {
    expectEdge(
      "src/auto-reply/continuation/work-dispatch.ts",
      "src/auto-reply/continuation/work-dispatch-execution.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/work-dispatch-execution.ts",
      "src/auto-reply/continuation/work-dispatch.ts",
    );
    expect(scan.definitions.get("getContinuationReplyRunRegistry")).toEqual([
      "src/auto-reply/continuation/work-dispatch-execution.ts",
    ]);
  });

  it("keeps Card 4 delivery below batch dispatch and restart independent of batch", () => {
    expectEdge(
      "src/auto-reply/reply/post-compaction-delegate-dispatch.ts",
      "src/auto-reply/reply/post-compaction-delegate-delivery.ts",
    );
    expectNoEdge(
      "src/auto-reply/reply/post-compaction-delegate-delivery.ts",
      "src/auto-reply/reply/post-compaction-delegate-dispatch.ts",
    );
    expectEdge(
      "src/gateway/server-restart-sentinel.ts",
      "src/gateway/server-restart-sentinel-delivery.ts",
    );
    expectEdge(
      "src/gateway/server-restart-sentinel-delivery.ts",
      "src/auto-reply/reply/post-compaction-delegate-delivery.ts",
    );
    expectNoEdge(
      "src/gateway/server-restart-sentinel-delivery.ts",
      "src/auto-reply/reply/post-compaction-delegate-dispatch.ts",
    );
  });

  it("keeps Card 5 recovery above live dispatch and neutral staged dispatch", () => {
    expectEdge(
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
      "src/auto-reply/continuation/delegate-dispatch.ts",
    );
    expectEdge(
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
      "src/auto-reply/continuation/post-compaction-staged-dispatch.ts",
    );
    expectEdge(
      "src/auto-reply/continuation/post-compaction-release.ts",
      "src/auto-reply/continuation/post-compaction-staged-dispatch.ts",
      "dynamic-import",
    );
    expectEdge(
      "src/gateway/server-runtime-services.ts",
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
      "dynamic-import",
    );
    expectNoEdge(
      "src/auto-reply/continuation/delegate-dispatch.ts",
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/post-compaction-release.ts",
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/post-compaction-staged-dispatch.ts",
      "src/auto-reply/continuation/delegate-dispatch.ts",
    );
    expectNoEdge(
      "src/auto-reply/continuation/post-compaction-staged-dispatch.ts",
      "src/auto-reply/continuation/delegate-dispatch-recovery.ts",
    );
  });

  it("keeps continuation registration and lane waiters below their assemblers", () => {
    expectEdge("src/agents/openclaw-tools.ts", "src/agents/openclaw-tools.continuation.ts");
    expectNoEdge("src/agents/openclaw-tools.continuation.ts", "src/agents/openclaw-tools.ts");
    expectEdge("src/process/command-queue.ts", "src/process/command-queue-waiters.ts");
    expectNoEdge("src/process/command-queue-waiters.ts", "src/process/command-queue.ts");
  });

  it("keeps subagent continuation behavior behind the runtime coordinator", () => {
    expectEdge(
      "src/agents/subagent-announce.ts",
      "src/agents/subagent-announce.continuation.runtime.ts",
      "dynamic-import",
    );
    expectEdge(
      "src/agents/subagent-announce.continuation.runtime.ts",
      "src/agents/subagent-announce.continuation.accounting.ts",
    );
    expectEdge(
      "src/agents/subagent-announce.continuation.runtime.ts",
      "src/agents/subagent-announce.continuation-return.ts",
      "static-export",
    );
    expectNoEdge(
      "src/agents/subagent-announce.ts",
      "src/agents/subagent-announce.continuation.accounting.ts",
    );
    expectNoEdge(
      "src/agents/subagent-announce.ts",
      "src/agents/subagent-announce.continuation-return.ts",
    );
  });

  it("keeps reply and gateway compaction release on the shared focused owner", () => {
    expectEdge(
      "src/auto-reply/reply/agent-runner-embedded-candidate.ts",
      "src/auto-reply/reply/agent-runner-post-compaction-release.ts",
    );
    expectEdge(
      "src/gateway/server-methods/sessions.ts",
      "src/gateway/server-methods/sessions-compact.ts",
    );
    expectEdge(
      "src/gateway/server-methods/sessions-compact.ts",
      "src/auto-reply/reply/agent-runner-post-compaction-release.ts",
      "dynamic-import",
    );
  });
});
