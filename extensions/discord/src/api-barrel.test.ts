import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const API_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../api.ts");
const itOnSupportedNode = Number(process.versions.node.split(".")[0]) >= 22 ? it : it.skip;

function collectExportedNames(): Set<string> {
  const source = ts.createSourceFile(
    API_SOURCE_PATH,
    readFileSync(API_SOURCE_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) {
      continue;
    }
    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

describe("discord API barrel", () => {
  it("exports current internal entrypoints", () => {
    const exportedNames = collectExportedNames();

    for (const exportName of [
      "discordPlugin",
      "discordSetupPlugin",
      "buildDiscordComponentCustomId",
      "handleDiscordMessageAction",
      "parseDiscordComponentCustomIdForCarbon",
      "parseDiscordComponentCustomIdForInteraction",
      "parseDiscordModalCustomIdForCarbon",
      "parseDiscordModalCustomIdForInteraction",
      "fetchDiscordApplicationSummary",
      "DiscordSendResult",
    ]) {
      expect(exportedNames).toContain(exportName);
    }
  });

  itOnSupportedNode("links runtime exports used by bundled Discord wiring", async () => {
    const api = await import("../api.js");

    for (const exportName of [
      "DISCORD_COMPONENT_CUSTOM_ID_KEY",
      "buildDiscordComponentMessageFlags",
      "createDiscordFormModal",
      "handleDiscordMessageAction",
      "handleDiscordSubagentSpawning",
      "listEnabledDiscordAccounts",
      "parseDiscordComponentCustomIdForCarbon",
      "parseDiscordModalCustomIdForCarbon",
      "resolveDiscordRuntimeGroupPolicy",
      "tryHandleDiscordMessageActionGuildAdmin",
    ]) {
      expect(api).toHaveProperty(exportName);
    }
  });
});
