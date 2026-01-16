export type HookInstallSpec = {
  id?: string;
  kind: "bundled" | "npm" | "git";
  label?: string;
  package?: string;
  repository?: string;
  bins?: string[];
};

export type ClawdbotHookMetadata = {
  always?: boolean;
  hookKey?: string;
  emoji?: string;
  homepage?: string;
  /** Events this hook handles (e.g., ["command:new", "session:start"]) */
  events: string[];
  /** Optional export name (default: "default") */
  export?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: HookInstallSpec[];
};

export type HookInvocationPolicy = {
  enabled: boolean;
};

export type ParsedHookFrontmatter = Record<string, string>;

export type Hook = {
  name: string;
  description: string;
  source: "clawdbot-bundled" | "clawdbot-managed" | "clawdbot-workspace";
  filePath: string; // Path to HOOK.md
  baseDir: string; // Directory containing hook
  handlerPath: string; // Path to handler module (handler.ts/js)
};

export type HookEntry = {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
  clawdbot?: ClawdbotHookMetadata;
  invocation?: HookInvocationPolicy;
};

export type HookEligibilityContext = {
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
    note?: string;
  };
};

export type HookSnapshot = {
  hooks: Array<{ name: string; events: string[] }>;
  resolvedHooks?: Hook[];
  version?: number;
};
