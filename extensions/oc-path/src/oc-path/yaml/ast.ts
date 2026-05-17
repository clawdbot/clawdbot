import type { Document, LineCounter } from "yaml";

export interface YamlAst {
  readonly kind: "yaml";
  readonly raw: string;
  readonly doc: Document.Parsed;
  readonly lineCounter: LineCounter;
}
