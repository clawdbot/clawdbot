#!/usr/bin/env node

// Advisory audit for Control UI class selectors that have no production source reference.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import selectorParser, { type ClassName, type Selector } from "postcss-selector-parser";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const UI_ROOT = path.join(REPO_ROOT, "ui");
const UI_SOURCE_ROOT = path.join(UI_ROOT, "src");
const CLASS_TOKEN_PATTERN = /[-_A-Za-z][-_A-Za-z0-9]*/gu;
const CLASS_STEM_PATTERN = /(?:^|[\s"'`=])([-_A-Za-z][-_A-Za-z0-9]*)$/u;

type ExternalClassFamily = {
  matches: (className: string) => boolean;
  producer: string;
};

// These classes are emitted by dependencies rather than written literally in ui/src.
const EXTERNAL_CLASS_FAMILIES: ExternalClassFamily[] = [
  // highlight.js emits language token spans during markdown rendering.
  {
    matches: (className) => className === "hljs" || className.startsWith("hljs-"),
    producer: "highlight.js via ui/src/components/markdown-code-blocks.ts",
  },
  // CodeMirror owns cm-* editor DOM; its Lezer highlighter owns tok-* spans.
  {
    matches: (className) => className.startsWith("cm-") || className.startsWith("tok-"),
    producer:
      "CodeMirror and @lezer/highlight via ui/src/pages/chat/components/file-editor-view.ts",
  },
  // Web Awesome owns wa-* classes inside its component implementation.
  {
    matches: (className) => className.startsWith("wa-"),
    producer: "Web Awesome custom-element internals",
  },
  // ProseMirror owns the editor-root and state classes it adds to its DOM.
  {
    matches: (className) => className.startsWith("ProseMirror"),
    producer: "ProseMirror editor DOM",
  },
  // markdown-it-task-lists emits these two classes from parsed markdown.
  {
    matches: (className) =>
      className === "task-list-item" || className === "task-list-item-checkbox",
    producer:
      "markdown-it-task-lists via ui/src/components/markdown-parser.ts (the contains-task-list class is removed there)",
  },
];

type SourceReferences = {
  literalClasses: Set<string>;
  stems: Set<string>;
};

type SourceReferenceFile = SourceReferences & {
  file: string;
};

type DynamicClassBuilder = {
  defaultValue: string | null;
  dynamic: boolean;
  name: string;
  parameterIndex: number;
  suffix: string;
};

type DynamicClassBuilderCall = {
  arguments: Array<string | null>;
  name: string;
};

type DeadClassFinding = {
  classes: string[];
  endLine: number;
  file: string;
  selector: string;
  startLine: number;
  testOnlyFiles: string[];
};

function groupBy<T, K>(values: Iterable<T>, keyFor: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) {
      group.push(value);
    } else {
      groups.set(key, [value]);
    }
  }
  return groups;
}

function walkFiles(rootDir: string, accepts: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && accepts(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function relativeToRepo(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

function addLiteralClassTokens(value: string, output: Set<string>): void {
  for (const match of value.matchAll(CLASS_TOKEN_PATTERN)) {
    output.add(match[0]);
  }
}

function addTrailingClassStem(value: string, output: Set<string>): void {
  const stem = value.match(CLASS_STEM_PATTERN)?.[1];
  // Dynamic class families in this UI use kebab/BEM separators. Requiring one
  // avoids treating ordinary string assembly ("item" + index) as CSS evidence.
  if (stem?.includes("-")) {
    output.add(stem);
  }
}

function inlineConditionalStringValues(node: ts.Expression): string[] {
  if (
    !ts.isConditionalExpression(node) ||
    !ts.isStringLiteral(node.whenTrue) ||
    !ts.isStringLiteral(node.whenFalse)
  ) {
    return [];
  }
  return [node.whenTrue.text, node.whenFalse.text];
}

function classMapPropertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return null;
  }
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/** Collect literal class tokens and dynamic class stems from TypeScript source. */
export function collectControlUiClassReferences(
  source: string,
  fileName = "source.ts",
): SourceReferences {
  const literalClasses = new Set<string>();
  const stems = new Set<string>();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      addLiteralClassTokens(node.text, literalClasses);
    } else if (ts.isTemplateExpression(node)) {
      addLiteralClassTokens(node.head.text, literalClasses);
      addTrailingClassStem(node.head.text, stems);
      const firstSpan = node.templateSpans[0];
      if (node.head.text === "" && firstSpan) {
        for (const branch of inlineConditionalStringValues(firstSpan.expression)) {
          addTrailingClassStem(`${branch}${firstSpan.literal.text}`, stems);
        }
      }
      for (const span of node.templateSpans) {
        addLiteralClassTokens(span.literal.text, literalClasses);
        if (ts.isTemplateMiddle(span.literal)) {
          addTrailingClassStem(span.literal.text, stems);
        }
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left))
    ) {
      addTrailingClassStem(node.left.text, stems);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "classMap" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        const name = classMapPropertyName(property);
        if (name) {
          literalClasses.add(name);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { literalClasses, stems };
}

function declarationName(node: ts.FunctionLikeDeclaration): string | null {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return null;
}

function staticStringValue(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function classBuilderSuffix(
  following: ts.TemplateLiteralLikeNode,
): { dynamic: boolean; suffix: string } | null {
  if (following.text === "" || /^[\s"'`]/u.test(following.text)) {
    return { dynamic: false, suffix: "" };
  }
  const suffix = following.text.match(/^([-_A-Za-z0-9]+)/u)?.[1];
  if (!suffix) {
    return null;
  }
  const remainder = following.text.slice(suffix.length);
  if (remainder !== "" && !/^[\s"'`]/u.test(remainder)) {
    return null;
  }
  return {
    dynamic: ts.isTemplateMiddle(following) && remainder === "",
    suffix,
  };
}

function collectDynamicClassBuilderData(
  source: string,
  fileName: string,
): {
  builders: DynamicClassBuilder[];
  calls: DynamicClassBuilderCall[];
} {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const builders: DynamicClassBuilder[] = [];
  const calls: DynamicClassBuilderCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name) {
        calls.push({
          arguments: node.arguments.map((argument) => staticStringValue(argument)),
          name,
        });
      }
    }

    if (isFunctionLikeDeclaration(node) && node.body) {
      const name = declarationName(node);
      if (name) {
        const builderName: string = name;
        const parameters = new Map<string, { defaultValue: string | null; index: number }>();
        node.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) {
            parameters.set(parameter.name.text, {
              defaultValue: staticStringValue(parameter.initializer),
              index,
            });
          }
        });
        function visitBody(bodyNode: ts.Node): void {
          if (ts.isTemplateExpression(bodyNode)) {
            let precedingText = bodyNode.head.text;
            for (const span of bodyNode.templateSpans) {
              if (ts.isIdentifier(span.expression) && /(?:^|[\s"'`=])$/u.test(precedingText)) {
                const parameter = parameters.get(span.expression.text);
                const pattern = classBuilderSuffix(span.literal);
                if (parameter && pattern) {
                  builders.push({
                    ...pattern,
                    defaultValue: parameter.defaultValue,
                    name: builderName,
                    parameterIndex: parameter.index,
                  });
                }
              }
              precedingText = span.literal.text;
            }
          }
          ts.forEachChild(bodyNode, visitBody);
        }
        visitBody(node.body);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { builders, calls };
}

function addDynamicClassBuilderReferences(
  references: SourceReferences,
  builders: DynamicClassBuilder[],
  calls: DynamicClassBuilderCall[],
): void {
  const callsByName = groupBy(calls, (call) => call.name);
  for (const builder of builders) {
    const values = new Set<string>();
    if (builder.defaultValue !== null) {
      values.add(builder.defaultValue);
    }
    for (const call of callsByName.get(builder.name) ?? []) {
      const value = call.arguments[builder.parameterIndex];
      if (value !== null && value !== undefined) {
        values.add(value);
      }
    }
    for (const value of values) {
      const reference = `${value}${builder.suffix}`;
      (builder.dynamic ? references.stems : references.literalClasses).add(reference);
    }
  }
}

function mergeReferences(references: SourceReferences[]): SourceReferences {
  return {
    literalClasses: new Set(references.flatMap((entry) => [...entry.literalClasses])),
    stems: new Set(references.flatMap((entry) => [...entry.stems])),
  };
}

function collectSourceReferenceFiles(): {
  production: SourceReferences;
  tests: SourceReferenceFile[];
} {
  const sourceFiles = walkFiles(UI_SOURCE_ROOT, (fileName) => fileName.endsWith(".ts"));
  const productionFiles: SourceReferenceFile[] = [];
  const testFiles: SourceReferenceFile[] = [];
  const builders: DynamicClassBuilder[] = [];
  const calls: DynamicClassBuilderCall[] = [];
  for (const filePath of sourceFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    const entry = {
      file: relativeToRepo(filePath),
      ...collectControlUiClassReferences(source, filePath),
    };
    const isTestSupport =
      filePath.endsWith(".test.ts") ||
      filePath.endsWith(".test-support.ts") ||
      filePath.split(path.sep).includes("test-helpers");
    if (isTestSupport) {
      testFiles.push(entry);
    } else {
      productionFiles.push(entry);
      const builderData = collectDynamicClassBuilderData(source, filePath);
      builders.push(...builderData.builders);
      calls.push(...builderData.calls);
    }
  }

  const indexHtml = fs.readFileSync(path.join(UI_ROOT, "index.html"), "utf8");
  const htmlClasses = new Set<string>();
  addLiteralClassTokens(indexHtml, htmlClasses);
  productionFiles.push({
    file: "ui/index.html",
    literalClasses: htmlClasses,
    stems: new Set(),
  });

  const production = mergeReferences(productionFiles);
  addDynamicClassBuilderReferences(production, builders, calls);
  return {
    production,
    tests: testFiles,
  };
}

function isReferenced(className: string, references: SourceReferences): boolean {
  return (
    references.literalClasses.has(className) ||
    [...references.stems].some((stem) => className.startsWith(stem))
  );
}

function externalProducer(className: string): string | null {
  return EXTERNAL_CLASS_FAMILIES.find((family) => family.matches(className))?.producer ?? null;
}

function selectorClasses(selector: Selector): ClassName[] {
  const classes: ClassName[] = [];
  selector.walkClasses((classNode) => {
    classes.push(classNode);
  });
  return classes;
}

function selectorTargetsPart(selector: Selector): boolean {
  let targetsPart = false;
  selector.walkPseudos((pseudo) => {
    if (pseudo.value === "::part") {
      targetsPart = true;
    }
  });
  return targetsPart;
}

function ruleLines(rule: Rule): { startLine: number; endLine: number } {
  return {
    startLine: rule.source?.start?.line ?? 1,
    endLine: rule.source?.end?.line ?? rule.source?.start?.line ?? 1,
  };
}

function testOnlyFilesFor(classes: string[], tests: SourceReferenceFile[]): string[] {
  return tests
    .filter((test) => classes.some((className) => isReferenced(className, test)))
    .map((test) => test.file);
}

function auditStylesheet(
  filePath: string,
  references: SourceReferences,
  tests: SourceReferenceFile[],
): DeadClassFinding[] {
  const css = fs.readFileSync(filePath, "utf8");
  const root = postcss.parse(css, { from: filePath });
  const findings: DeadClassFinding[] = [];
  root.walkRules((rule) => {
    const parsed = selectorParser().astSync(rule.selector);
    for (const selector of parsed.nodes) {
      const classes = selectorClasses(selector);
      // Element selectors (including html/body/:root) never become class
      // candidates. ::part selectors target component-owned shadow DOM.
      if (classes.length === 0 || selectorTargetsPart(selector)) {
        continue;
      }
      const classNames = [...new Set(classes.map((classNode) => classNode.value))];
      const keptAlive = classNames.some(
        (className) => externalProducer(className) || isReferenced(className, references),
      );
      if (keptAlive) {
        continue;
      }
      findings.push({
        ...ruleLines(rule),
        classes: classNames,
        file: relativeToRepo(filePath),
        selector: selector.toString().trim(),
        testOnlyFiles: testOnlyFilesFor(classNames, tests),
      });
    }
  });
  return findings;
}

function collectDeadClassFindings(): DeadClassFinding[] {
  const references = collectSourceReferenceFiles();
  const stylesheets = walkFiles(UI_SOURCE_ROOT, (fileName) => fileName.endsWith(".css"));
  return stylesheets.flatMap((filePath) =>
    auditStylesheet(filePath, references.production, references.tests),
  );
}

function formatReport(findings: DeadClassFinding[]): string {
  if (findings.length === 0) {
    return "Control UI dead-CSS audit: 0 dead class selectors.";
  }
  const byFile = groupBy(findings, (finding) => finding.file);
  const lines = ["Control UI dead-CSS audit (advisory):"];
  for (const [file, fileFindings] of byFile) {
    lines.push(`\n${file}`);
    for (const finding of fileFindings) {
      const lineRange =
        finding.startLine === finding.endLine
          ? `line ${finding.startLine}`
          : `lines ${finding.startLine}-${finding.endLine}`;
      lines.push(`  ${finding.classes.map((name) => `.${name}`).join(", ")} (${lineRange})`);
      lines.push(`    selector: ${finding.selector}`);
      if (finding.testOnlyFiles.length > 0) {
        lines.push(`    test-only reference: ${finding.testOnlyFiles.join(", ")}`);
      }
    }
  }
  const classCount = findings.reduce((count, finding) => count + finding.classes.length, 0);
  lines.push(
    `\nSummary: ${classCount} dead class selector${classCount === 1 ? "" : "s"} in ${findings.length} selector${findings.length === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)): void {
  if (argv.length > 0) {
    throw new Error(`Unknown option: ${argv[0]}`);
  }
  process.stdout.write(`${formatReport(collectDeadClassFindings())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
