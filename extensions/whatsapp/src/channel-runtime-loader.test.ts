// Whatsapp tests cover the source-safe channel runtime loading boundary.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isWhatsAppAuthConfigured, loadWhatsAppChannelRuntime } from "./channel-runtime-loader.js";

const runtimeLoads = vi.hoisted(() => ({
  order: [] as string[],
  readWebAuthState: vi.fn(async () => "linked" as const),
}));

vi.mock("./auth-store.js", () => {
  runtimeLoads.order.push("auth-store");
  return { readWebAuthState: runtimeLoads.readWebAuthState };
});

vi.mock("./channel.runtime.js", () => {
  runtimeLoads.order.push("channel-runtime");
  return { monitorWebChannel: vi.fn() };
});

const sourceDir = fileURLToPath(new URL(".", import.meta.url));

function listChannelRuntimeImportOwners(): string[] {
  const owners: string[] = [];
  for (const relativePath of readdirSync(sourceDir, { encoding: "utf8", recursive: true })) {
    if (!relativePath.endsWith(".ts") || relativePath.includes(".test")) {
      continue;
    }
    const filePath = path.join(sourceDir, relativePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) && argument.text.endsWith("channel.runtime.js"),
        )
      ) {
        owners.push(relativePath);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return owners.toSorted();
}

describe("WhatsApp channel runtime loader", () => {
  it("shares imports and resolves auth before the channel runtime", async () => {
    const firstRuntimeLoad = loadWhatsAppChannelRuntime();

    expect(loadWhatsAppChannelRuntime()).toBe(firstRuntimeLoad);
    await expect(
      Promise.all([isWhatsAppAuthConfigured("/tmp/default"), firstRuntimeLoad]),
    ).resolves.toEqual([true, expect.any(Object)]);
    expect(runtimeLoads.order).toEqual(["auth-store", "channel-runtime"]);
    expect(runtimeLoads.readWebAuthState).toHaveBeenCalledOnce();
  });

  it("keeps one production owner for the channel runtime import", () => {
    expect(listChannelRuntimeImportOwners()).toEqual(["channel-runtime-loader.ts"]);
  });
});
