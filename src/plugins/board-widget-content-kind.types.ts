/** Plugin-owned source kind rendered through the board's sandboxed document host. */
export type PluginBoardWidgetContentKind = {
  /** Agent-facing kind, for example `diagram`. Must be globally unique. */
  kind: string;
  /** Short label shown in dashboard chrome. */
  label: string;
  /** Capability-scoped static resources used by the composed document. */
  resources: {
    surface: string;
    paths: string[];
  };
  /** Reject malformed or unsupported source before it reaches persistent storage. */
  validateSource: (source: string) => void;
  /** Build the untrusted document body; core adds the canonical bridge and CSP shell. */
  composeDocument: (params: {
    source: string;
    title: string;
    resourceUrls: Readonly<Record<string, string>>;
    promptGranted: boolean;
  }) => string;
};
