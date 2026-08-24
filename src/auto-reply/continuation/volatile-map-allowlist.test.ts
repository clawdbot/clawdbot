import { readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type CollectionKind = "Map" | "Set" | "WeakMap";

type AllowlistEntry = {
  file: string;
  symbol: string;
  owner: string;
  purpose: string;
  safeVolatileClassification: string;
  restartContract: string;
};

type Finding = {
  file: string;
  symbol: string;
  line: number;
  collectionKind: CollectionKind;
};

type Candidate = Finding & {
  expression: ts.NewExpression;
  typeArguments: readonly string[];
};

const SOURCE_ROOT = process.cwd();

const ALLOWLIST = [
  {
    file: "src/auto-reply/continuation/state.ts",
    symbol: "continuationTimerHandles",
    owner: "continuation timer registry",
    purpose: "Tracks the live setTimeout handles owned by each continuation sessionKey.",
    safeVolatileClassification:
      "Timer handles are Node process objects; persisting them would not make a restarted process able to clear or fire the old timeout.",
    restartContract:
      "Lost on process restart; durable delayed delegate intent stays in TaskFlow and is reloaded by the next continuation scheduling pass.",
  },
  {
    file: "src/auto-reply/continuation/state.ts",
    symbol: "continuationTimerRefs",
    owner: "continuation timer registry",
    purpose:
      "Counts currently live continuation timers per sessionKey for process-liveness checks.",
    safeVolatileClassification:
      "The ref count mirrors in-process timeout handles only and has no durable meaning without those handles.",
    restartContract:
      "Reset to empty on process restart; pending delegate records remain in TaskFlow and rebuild timer state when scheduling resumes.",
  },
  {
    file: "src/auto-reply/continuation/delegate-dispatch-hedge.ts",
    symbol: "hedgeTimers",
    owner: "continuation delegate dispatcher",
    purpose:
      "Keeps one hedge setTimeout per sessionKey so quiet channels re-check unmatured pending delegates.",
    safeVolatileClassification:
      "The map stores timeout handles for the current Node process; the underlying pending delegates are persisted in TaskFlow.",
    restartContract:
      "Lost on process restart; the TaskFlow queue remains and the next dispatch/finalize cycle can arm a fresh hedge.",
  },
  {
    file: "src/auto-reply/continuation/work-dispatch.ts",
    symbol: "workTimers",
    owner: "continuation work dispatcher",
    purpose:
      "Keeps one setTimeout handle per sessionKey for scheduled continue_work follow-through on the main lane.",
    safeVolatileClassification:
      "The map stores timeout handles for the current Node process; the underlying continue_work intent is persisted in TaskFlow.",
    restartContract:
      "Lost on process restart; the TaskFlow queue remains and the next continuation scheduling pass can arm a fresh work timer.",
  },
  {
    file: "src/auto-reply/continuation/work-dispatch.ts",
    symbol: "idleRetryControllers",
    owner: "continuation work dispatcher",
    purpose:
      "Dedupes the live AbortController waiting for a reply-run end or command-lane idle event before retrying a busy continue_work row.",
    safeVolatileClassification:
      "The map stores AbortControllers and in-process waiter closures; the durable retry intent and slow hedge dueAt are persisted in TaskFlow.",
    restartContract:
      "Lost on process restart; pending continuation work remains in TaskFlow and recovery re-arms the hedge timer so the row is not stranded.",
  },
  {
    file: "src/auto-reply/continuation/work-dispatch.ts",
    symbol: "idleRetryFailureTimers",
    owner: "continuation work dispatcher",
    purpose:
      "Keeps a short recovery setTimeout per sessionKey when idle-event waiter registration fails, so queued idle-retry rows are retried without waiting for the slow hedge.",
    safeVolatileClassification:
      "The map stores timeout handles for the current Node process; the queued idle-retry intent remains persisted in TaskFlow.",
    restartContract:
      "Lost on process restart; pending continuation work remains in TaskFlow and restart recovery/normal scheduling can re-arm recovery or hedge timers from durable rows.",
  },
  {
    file: "src/auto-reply/continuation/continuation-dispatch-claims.ts",
    symbol: "activeWorkDispatchControllers",
    owner: "continuation work dispatch claim registry",
    purpose:
      "Tracks live AbortControllers for claimed continue_work callbacks so explicit reset can close them before provider admission.",
    safeVolatileClassification:
      "The map contains only current-process execution controllers; durable TaskFlow rows remain the restart and recovery authority.",
    restartContract:
      "Lost on process restart; running TaskFlow rows remain recoverable only after the stale-running cutoff and reacquire a fresh controller.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "activeRunsByKey",
    owner: "reply run registry singleton",
    purpose: "Maps sessionKey to the live ReplyOperation currently executing in this process.",
    safeVolatileClassification:
      "ReplyOperation wraps live AbortController/backend state and cannot be serialized or resumed across process boundaries.",
    restartContract:
      "Lost on process restart; no in-flight operation is reported active and a later request creates a new ReplyOperation.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "activeSessionIdsByKey",
    owner: "reply run registry singleton",
    purpose:
      "Maps each active sessionKey to the current sessionId bound to its live reply operation.",
    safeVolatileClassification:
      "The binding is only meaningful while the in-process ReplyOperation exists.",
    restartContract:
      "Lost on process restart together with the live ReplyOperation; durable session identity remains in the session store.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "activeKeysBySessionId",
    owner: "reply run registry singleton",
    purpose:
      "Provides the reverse sessionId to sessionKey lookup for active in-process reply operations.",
    safeVolatileClassification:
      "The reverse index mirrors activeRunsByKey and contains no durable state beyond the live operation registry.",
    restartContract:
      "Lost on process restart; lookups return no active run until a new operation registers itself.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "waitKeysBySessionId",
    owner: "reply run registry singleton",
    purpose:
      "Keeps temporary sessionId to sessionKey wait bindings while a live reply operation may rebind session ids.",
    safeVolatileClassification:
      "Wait bindings serve current-process waitForIdle callers and are valid only alongside the live operation.",
    restartContract:
      "Lost on process restart; callers waiting in the old process disappear with that process.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "waitersByKey",
    owner: "reply run registry singleton",
    purpose: "Stores waitForIdle promise resolvers and timeout handles by active sessionKey.",
    safeVolatileClassification:
      "Waiters and their timeout handles are process-local continuations for callers in this Node process.",
    restartContract:
      "Lost on process restart; old waiters cannot be resolved because their callers no longer exist.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "attachedBackendByOperation",
    owner: "reply run registry singleton",
    purpose: "Weakly associates live ReplyOperation objects with their current backend handles.",
    safeVolatileClassification:
      "WeakMap keys and backend handles are process objects; persisting either would be meaningless and would defeat weak-reference semantics.",
    restartContract:
      "Lost on process restart; new ReplyOperation instances attach fresh backend handles when work resumes.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "followupAdmissionBarriersByKey",
    owner: "reply run registry singleton",
    purpose:
      "Maps each active sessionKey to its in-flight followup admission barrier (a settle Promise plus the bound sessionId) that gates whether a followup reply may be admitted.",
    safeVolatileClassification:
      "Each barrier holds a live in-process settle Promise and a failsafe timer; Promises and timer handles cannot be serialized or resumed across process boundaries.",
    restartContract:
      "Lost on process restart; durable followup intent remains in TaskFlow and the session store, and the next admission pass arms a fresh barrier.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "afterClearCallbacksByOperation",
    owner: "reply run registry singleton",
    purpose:
      "Weakly associates a live ReplyOperation with the set of after-clear callbacks to run once that operation no longer owns its session lane.",
    safeVolatileClassification:
      "WeakMap keys are live ReplyOperation process objects and the values are in-process callback closures; persisting either would be meaningless and would defeat weak-reference semantics.",
    restartContract:
      "Lost on process restart; new ReplyOperation instances register fresh after-clear callbacks when work resumes.",
  },
  {
    file: "src/auto-reply/continuation/delegate-turn-admission.ts",
    symbol: "delegatesScheduledThisTurn",
    owner: "continue_delegate per-turn admission",
    purpose:
      "Counts how many continue_delegate calls a session has scheduled in the current assistant turn so the maxDelegatesPerTurn cap resets at each assistant-turn boundary (the tool list is built once per run).",
    safeVolatileClassification:
      "The count is turn-scoped rate state, not durable delegate substrate; the delegates themselves are persisted in the TaskFlow-backed delegate store, and the cap is also enforced by the post-response dispatcher.",
    restartContract:
      "Lost on process restart, which is the correct post-restart state: the next turn starts at a zero admission count and the durable delegate queue is unaffected.",
  },
  {
    file: "src/auto-reply/continuation/delegate-taskflow-registry.test-harness.ts",
    symbol: "mockTaskFlows",
    owner: "continuation TaskFlow test harness",
    purpose:
      "Holds the in-memory TaskFlow rows a unit test registers in place of the durable TaskFlow store.",
    safeVolatileClassification:
      "Test-harness-only fixture state; it never runs in production and is reset between tests by resetMockTaskFlows().",
    restartContract:
      "Not applicable to production restarts; each test run starts from an empty map and the real durable store is untouched.",
  },
  {
    file: "src/auto-reply/continuation/work-terminal-notice.ts",
    symbol: "retryTimers",
    owner: "continuation terminal-notice retrier",
    purpose:
      "Keeps one live retry setTimeout per terminal-notice key while a failed durable handoff notice is re-attempted.",
    safeVolatileClassification:
      "The map stores Node timeout handles for the current process; the terminal-notice intent itself is persisted durably.",
    restartContract:
      "Lost on process restart; the durable terminal notice remains and the next delivery pass can arm a fresh retry timer.",
  },
  {
    file: "src/auto-reply/reply/reply-run-finalization-lease.ts",
    symbol: "activeLeases",
    owner: "reply run finalization lease registry",
    purpose:
      "Tracks the finalization leases currently held by in-process reply runs so shutdown can drain them.",
    safeVolatileClassification:
      "Leases wrap live in-process callbacks and abort plumbing that cannot outlive the Node process.",
    restartContract:
      "Lost on process restart; no lease is reported held and a new run acquires a fresh lease before finalizing.",
  },
  {
    file: "src/auto-reply/reply/reply-run-finalization-lease.ts",
    symbol: "activeSettleTimers",
    owner: "reply run finalization lease registry",
    purpose: "Tracks the live settle timers armed for in-process reply-run finalization.",
    safeVolatileClassification:
      "Settle timers are Node timeout wrappers; persisting them could not make a restarted process clear or fire the old timeout.",
    restartContract:
      "Lost on process restart; the durable reply/continuation state remains and a later run arms new settle timers.",
  },
  {
    file: "src/auto-reply/reply/reply-run-finalization-lease.ts",
    symbol: "leasesByOwner",
    owner: "reply run finalization lease registry",
    purpose: "Weakly maps a live owner object to the finalization lease it currently holds.",
    safeVolatileClassification:
      "WeakMap keyed by process objects; persisting it would be meaningless and would defeat weak-reference semantics.",
    restartContract:
      "Lost on process restart together with its owner objects; no durable finalization state depends on it.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "successorAdmissionBarriersByKey",
    owner: "reply run registry singleton",
    purpose:
      "Holds the admission barrier a successor reply run must clear before it may start on a sessionKey.",
    safeVolatileClassification:
      "Barriers wrap in-process promises/resolvers that only gate live operations in this Node process.",
    restartContract:
      "Lost on process restart; with no live predecessor operation there is nothing to fence, so a new run admits immediately.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "evictOperationByOperation",
    owner: "reply run registry singleton",
    purpose: "Weakly associates a live ReplyOperation with its registry eviction callback.",
    safeVolatileClassification:
      "WeakMap of process objects to closures; neither side is serializable or meaningful across processes.",
    restartContract: "Lost on process restart; the operations it would evict no longer exist.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "operationsByUpstreamAbortSignal",
    owner: "reply run registry singleton",
    purpose: "Resolves the live ReplyOperation that an upstream AbortSignal should cancel.",
    safeVolatileClassification:
      "AbortSignals and ReplyOperations are process objects; the mapping has no meaning outside this process.",
    restartContract:
      "Lost on process restart; the upstream callers holding those signals are gone with the process.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "successorBarrierStartsByOperation",
    owner: "reply run registry singleton",
    purpose:
      "Weakly records the start callbacks that release successor fences once an operation begins.",
    safeVolatileClassification:
      "WeakMap of live ReplyOperations to in-process closures; nothing durable is represented.",
    restartContract:
      "Lost on process restart; no live successor is waiting, so no fence needs releasing.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "successorBarrierGroupsByOperation",
    owner: "reply run registry singleton",
    purpose:
      "Weakly groups the alias-keyed successor fences that rotate together for one lane of a live operation.",
    safeVolatileClassification:
      "WeakMap of live ReplyOperations to in-process barrier sets; lane identity is rebuilt from durable session state when runs restart.",
    restartContract:
      "Lost on process restart; a restarted process re-registers lane fences when it creates new operations.",
  },
  {
    file: "src/auto-reply/reply/reply-run-registry.state.ts",
    symbol: "expireReplyOperationByOperation",
    owner: "reply run registry singleton",
    purpose: "Weakly associates a live ReplyOperation with its stale-expiry callback.",
    safeVolatileClassification:
      "WeakMap of process objects to closures; expiring an operation is only meaningful while it is running.",
    restartContract: "Lost on process restart; there is no in-flight operation left to expire.",
  },
  {
    file: "src/auto-reply/reply/reply-run-typing.ts",
    symbol: "typingByReplyOperation",
    owner: "reply run typing binder",
    purpose:
      "Keeps one typing/feedback controller attached to the live ReplyOperation that owns a reply run.",
    safeVolatileClassification:
      "WeakMap of live ReplyOperations to transport-bound typing controllers; both are process objects.",
    restartContract:
      "Lost on process restart; typing indicators stop with the process and are re-established by the next run.",
  },
] as const satisfies readonly AllowlistEntry[];

// These older reply-continuation symbols are already pinned by
// src/auto-reply/reply/continuation-state.test.ts. OV-5 guards the TaskFlow
// continuation surface's reviewed 10 safe-volatile remnants.
const EXISTING_GUARD_OWNED_SYMBOLS = new Set([
  "src/auto-reply/continuation/context-pressure.ts:lastFiredBand",
  "src/auto-reply/reply/continuation-state.ts:continuationGenerations",
  "src/auto-reply/reply/continuation-state.ts:continuationTimerHandles",
  "src/auto-reply/reply/continuation-state.ts:continuationTimerRefs",
]);

const MUTATING_COLLECTION_METHODS = new Set(["add", "clear", "delete", "set"]);
const STATE_KEYWORD_PATTERN = /\b(session|run|task|chain|delegate|queue|operation)\b/i;

function collectContinuationSurfaceFiles(): string[] {
  const continuationFiles = collectTypeScriptFiles("src/auto-reply/continuation", {
    recursive: true,
  });
  const replyFiles = collectTypeScriptFiles("src/auto-reply/reply", {
    recursive: false,
  }).filter((file) => {
    const name = basename(file);
    return (
      name.startsWith("continuation-") ||
      name.startsWith("post-compaction-") ||
      name.startsWith("reply-run-")
    );
  });
  const agentFiles = [
    "src/agents/subagents/announce/subagent-announce.ts",
    "src/agents/subagents/spawn/subagent-spawn.ts",
  ];

  return [...new Set([...continuationFiles, ...replyFiles, ...agentFiles])].toSorted();
}

function collectTypeScriptFiles(relativeDir: string, options: { recursive: boolean }): string[] {
  const absoluteDir = join(SOURCE_ROOT, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (options.recursive) {
        files.push(...collectTypeScriptFiles(relativePath, options));
      }
      continue;
    }
    if (entry.isFile() && isProductionTypeScriptFile(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function isProductionTypeScriptFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");
}

function scanContinuationSurface(): Finding[] {
  return collectContinuationSurfaceFiles().flatMap(scanFileForVolatileCollections);
}

function scanFileForVolatileCollections(file: string): Finding[] {
  const sourceText = readFileSync(join(SOURCE_ROOT, file), "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const mutatedSymbols = collectMutatedCollectionSymbols(sourceFile);
  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    const candidate = candidateFromNode(file, sourceFile, node);
    if (candidate && isStateBearingCandidate(candidate, mutatedSymbols)) {
      findings.push({
        file: candidate.file,
        symbol: candidate.symbol,
        line: candidate.line,
        collectionKind: candidate.collectionKind,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings.toSorted(compareFindings);
}

function collectMutatedCollectionSymbols(sourceFile: ts.SourceFile): Set<string> {
  const symbols = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (MUTATING_COLLECTION_METHODS.has(methodName)) {
        const receiverName = collectionReceiverName(node.expression.expression);
        if (receiverName) {
          symbols.add(receiverName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

function collectionReceiverName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function candidateFromNode(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Candidate | undefined {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    isModuleLevelVariableDeclaration(node)
  ) {
    return candidateFromInitializer(file, sourceFile, node.name.text, node, node.initializer);
  }

  if (ts.isPropertyAssignment(node) && hasResolveGlobalSingletonAncestor(node, sourceFile)) {
    const symbol = propertyNameText(node.name);
    if (symbol) {
      return candidateFromInitializer(file, sourceFile, symbol, node, node.initializer);
    }
  }

  if (
    ts.isPropertyDeclaration(node) &&
    node.initializer &&
    isModuleLevelClassPropertyDeclaration(node)
  ) {
    const symbol = propertyNameText(node.name);
    if (symbol) {
      return candidateFromInitializer(file, sourceFile, symbol, node, node.initializer);
    }
  }

  return undefined;
}

function candidateFromInitializer(
  file: string,
  sourceFile: ts.SourceFile,
  symbol: string,
  node: ts.Node,
  initializer: ts.Expression,
): Candidate | undefined {
  const collectionKind = collectionConstructorName(initializer);
  if (!collectionKind || !ts.isNewExpression(initializer)) {
    return undefined;
  }
  return {
    file,
    symbol,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    collectionKind,
    expression: initializer,
    typeArguments:
      initializer.typeArguments?.map((typeArgument) => typeArgument.getText(sourceFile)) ?? [],
  };
}

function collectionConstructorName(expression: ts.Expression): CollectionKind | undefined {
  if (!ts.isNewExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return undefined;
  }
  const constructorName = expression.expression.text;
  return constructorName === "Map" || constructorName === "Set" || constructorName === "WeakMap"
    ? constructorName
    : undefined;
}

function isModuleLevelVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent)
  );
}

function isModuleLevelClassPropertyDeclaration(node: ts.PropertyDeclaration): boolean {
  return ts.isClassDeclaration(node.parent) && ts.isSourceFile(node.parent.parent);
}

function hasResolveGlobalSingletonAncestor(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== sourceFile) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "resolveGlobalSingleton"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isStateBearingCandidate(
  candidate: Candidate,
  mutatedSymbols: ReadonlySet<string>,
): boolean {
  if (EXISTING_GUARD_OWNED_SYMBOLS.has(findingKey(candidate))) {
    return false;
  }
  if (
    ALLOWLIST.some((entry) => entry.file === candidate.file && entry.symbol === candidate.symbol)
  ) {
    return true;
  }
  if (candidate.collectionKind === "WeakMap") {
    return true;
  }
  if (
    hasStateKeyword(candidate.symbol) ||
    candidate.typeArguments.some(hasStateKeyword) ||
    mutatedSymbols.has(candidate.symbol)
  ) {
    return true;
  }
  if (candidate.collectionKind === "Map" && isStringKeyedEmptyMap(candidate)) {
    return true;
  }
  return candidate.collectionKind === "Set" && isEmptyConstructor(candidate.expression);
}

function hasStateKeyword(value: string): boolean {
  return STATE_KEYWORD_PATTERN.test(value);
}

function isStringKeyedEmptyMap(candidate: Candidate): boolean {
  return (
    candidate.typeArguments[0]?.replaceAll(/\s+/g, "") === "string" &&
    isEmptyConstructor(candidate.expression)
  );
}

function isEmptyConstructor(expression: ts.NewExpression): boolean {
  return expression.arguments === undefined || expression.arguments.length === 0;
}

function findingKey(finding: Pick<Finding, "file" | "symbol">): string {
  return `${finding.file}:${finding.symbol}`;
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.symbol.localeCompare(right.symbol)
  );
}

describe("volatile-map allowlist (continuation surface guard-test)", () => {
  it("rejects new session-keyed volatile Maps outside the reviewed allowlist", () => {
    const findings = scanContinuationSurface();
    const allowlistKeys = new Set(ALLOWLIST.map(findingKey));
    const findingKeys = new Set(findings.map(findingKey));
    const unjustified = findings.filter((finding) => !allowlistKeys.has(findingKey(finding)));
    const missing = ALLOWLIST.filter((entry) => !findingKeys.has(findingKey(entry)));

    for (const entry of ALLOWLIST) {
      expect(entry.owner).not.toBe("");
      expect(entry.purpose).not.toBe("");
      expect(entry.safeVolatileClassification).not.toBe("");
      expect(entry.restartContract).not.toBe("");
    }

    expect(
      { unjustified, missing },
      JSON.stringify({ unjustified, missing, findings }, null, 2),
    ).toEqual({
      unjustified: [],
      missing: [],
    });
    expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(ALLOWLIST.length);
  });
});
