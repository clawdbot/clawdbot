import { describe, expect, it } from "vitest";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";

function rootWithTokens(tokens: Record<string, string>): HTMLElement {
  const element = document.createElement("div");
  for (const [name, value] of Object.entries(tokens)) {
    element.style.setProperty(name, value);
  }
  document.body.append(element);
  return element;
}

describe("collectMcpAppStyleVariables", () => {
  it("publishes Control UI tokens under specification keys", () => {
    const variables = collectMcpAppStyleVariables(
      rootWithTokens({
        "--card": "#161920",
        "--bg": "#0e1015",
        "--text": "#d4d4d8",
        "--border": "#1e2028",
        "--radius": "10px",
      }),
    );

    expect(variables?.["--color-background-primary"]).toBe("#161920");
    expect(variables?.["--color-background-secondary"]).toBe("#0e1015");
    expect(variables?.["--color-text-primary"]).toBe("#d4d4d8");
    expect(variables?.["--color-border-primary"]).toBe("#1e2028");
    expect(variables?.["--border-radius-md"]).toBe("10px");
  });

  it("omits keys the host cannot source instead of publishing empty values", () => {
    const variables = collectMcpAppStyleVariables(rootWithTokens({ "--card": "#161920" }));

    expect(variables).not.toHaveProperty("--color-text-primary");
    expect(
      Object.values(variables ?? {}).every(
        (value) => typeof value === "string" && value.length > 0,
      ),
    ).toBe(true);
  });

  it("preserves text hierarchy and inverse-surface contrast", () => {
    const variables = collectMcpAppStyleVariables(
      rootWithTokens({
        "--text": "#d4d4d8",
        "--muted-strong": "#a1a1aa",
        "--muted": "#71717a",
        "--bg": "#0e1015",
      }),
    );

    expect(variables?.["--color-text-secondary"]).toBe("#a1a1aa");
    expect(variables?.["--color-text-tertiary"]).toBe("#71717a");
    expect(variables?.["--color-background-inverse"]).toBe("#d4d4d8");
    expect(variables?.["--color-text-inverse"]).toBe("#0e1015");
    expect(variables?.["--color-border-inverse"]).toBe("#0e1015");
  });

  it("never publishes a font stack whose leading face the sandbox cannot load", () => {
    const variables = collectMcpAppStyleVariables(
      rootWithTokens({
        "--font-body": '"Inter", sans-serif',
        "--mono": '"JetBrains Mono", monospace',
      }),
    );

    // Font requests are limited to resource domains the app declares, so a
    // host-led brand face resolves to an arbitrary system face rather than
    // failing visibly. The published stacks are the carapace embed stacks:
    // system resolvable, independent of the host's own font tokens.
    expect(variables?.["--font-sans"]).toMatch(/^system-ui,/);
    expect(variables?.["--font-sans"]).not.toContain("Inter");
    expect(variables?.["--font-mono"]).toMatch(/^ui-monospace,/);
    expect(variables?.["--font-mono"]).not.toContain("JetBrains");
  });

  it("publishes trimmed, non-empty values", () => {
    const variables = collectMcpAppStyleVariables(
      rootWithTokens({ "--card": "  #161920  ", "--bg": "#0e1015" }),
    );

    // Values cross into a separate origin, where a Control UI token name would
    // have nothing to resolve against. Browsers substitute nested var()
    // references when computing a custom property, which is what makes the
    // published values self-contained; jsdom does not implement that
    // substitution, so the guarantee is verified in a browser rather than here.
    expect(variables?.["--color-background-primary"]).toBe("#161920");
    expect(
      Object.values(variables ?? {}).every(
        (value) => typeof value === "string" && value === value.trim(),
      ),
    ).toBe(true);
  });

  it("publishes only specification keys", () => {
    const variables = collectMcpAppStyleVariables(rootWithTokens({ "--card": "#161920" }));

    // The transported record is validated against a closed key set, so an
    // OpenClaw name here would be rejected for the whole payload.
    expect(Object.keys(variables ?? {}).filter((key) => key.startsWith("--oc-"))).toEqual([]);
    expect(
      Object.keys(variables ?? {}).every(
        (key) =>
          key.startsWith("--color-") ||
          key.startsWith("--font-") ||
          key.startsWith("--border-") ||
          key.startsWith("--shadow-"),
      ),
    ).toBe(true);
  });
});
