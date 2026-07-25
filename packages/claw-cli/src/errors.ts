import type { CliDiagnostic } from "./types.js";

export class CliError extends Error {
  readonly diagnostics: CliDiagnostic[];
  readonly harness?: { id: string; outcome: unknown };

  constructor(
    diagnostic: CliDiagnostic | CliDiagnostic[],
    options: { harness?: { id: string; outcome: unknown } } = {},
  ) {
    const diagnostics = Array.isArray(diagnostic) ? diagnostic : [diagnostic];
    super(diagnostics.map((entry) => entry.message).join("\n"));
    this.name = "CliError";
    this.diagnostics = diagnostics;
    this.harness = options.harness;
  }
}
