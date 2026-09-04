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
    /**
     * Public static renderer bytes served without Gateway credentials.
     * Declaring this reader reserves every path globally across content kinds,
     * including registrations without a public reader.
     * Public paths must be canonical URL pathnames and cannot use `/mcp-app-sandbox`.
     */
    readPublicResource?: (
      path: string,
    ) => Promise<{ body: Uint8Array; contentType: string } | undefined>;
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
