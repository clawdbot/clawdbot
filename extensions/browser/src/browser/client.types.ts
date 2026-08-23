/**
 * Browser client response types.
 *
 * Shared by the browser control client, CLI, and Browser agent tool.
 */
/** Browser transport backing the selected profile. */
export type BrowserTransport = "cdp" | "chrome-mcp" | "extension";
type BrowserHeadlessSource =
  | "request"
  | "env"
  | "profile"
  | "config"
  | "linux-display-fallback"
  | "default";

export type BrowserGraphicsAcceleration = "hardware" | "software" | "unknown";

export type BrowserGraphicsDevice = {
  vendorId: number;
  deviceId: number;
  vendor: string;
  device: string;
  driverVendor: string;
  driverVersion: string;
};

export type BrowserVideoDecodeCapability = {
  profile: string;
  minResolution: { width: number; height: number };
  maxResolution: { width: number; height: number };
};

export type BrowserVideoEncodeCapability = {
  profile: string;
  maxResolution: { width: number; height: number };
  maxFramerateNumerator: number;
  maxFramerateDenominator: number;
};

export type BrowserGraphicsDiagnostics =
  | {
      status: "available";
      observedAt: number;
      acceleration: BrowserGraphicsAcceleration;
      renderer: string | null;
      vendor: string | null;
      version: string | null;
      backend: string | null;
      devices: BrowserGraphicsDevice[];
      featureStatus: Record<string, string>;
      disabledFeatures: Array<{ feature: string; status: string }>;
      driverBugWorkarounds: string[];
      videoDecoding: BrowserVideoDecodeCapability[];
      videoEncoding: BrowserVideoEncodeCapability[];
    }
  | {
      status: "unavailable";
      observedAt: number;
      reason: string;
    };

export type BrowserTabOwnership =
  | {
      status: "durable";
      nativeTargetId: string;
      profileFingerprint: string;
      browserInstanceFingerprint: string;
    }
  | {
      status: "non-durable";
      reason:
        | "explicit-cdp-url-required"
        | "target-marker-not-unique"
        | "target-marker-lookup-failed"
        | "target-lookup-failed"
        | "browser-identity-unavailable"
        | "browser-identity-lookup-failed";
    };

/** Browser status response returned by the control server. */
export type BrowserStatus = {
  enabled: boolean;
  profile?: string;
  driver?: "openclaw" | "existing-session" | "extension";
  transport?: BrowserTransport;
  running: boolean;
  cdpReady?: boolean;
  cdpHttp?: boolean;
  /**
   * For Chrome MCP existing-session profiles, true only if a page-level tool
   * round-trip (`list_pages`) completes; for managed CDP profiles, mirrors
   * `cdpReady`. Distinguishes "transport handshake passed" from "page tools
   * are actually usable".
   */
  pageReady?: boolean;
  pid: number | null;
  cdpPort: number | null;
  cdpUrl?: string | null;
  chosenBrowser: string | null;
  detectedBrowser?: string | null;
  detectedExecutablePath?: string | null;
  detectError?: string | null;
  userDataDir: string | null;
  color: string;
  headless: boolean;
  headlessSource?: BrowserHeadlessSource;
  noSandbox?: boolean;
  executablePath?: string | null;
  attachOnly: boolean;
  /**
   * Cached process-lifetime diagnostics for a locally launched managed browser.
   * Passive status calls never launch a browser to populate this field.
   */
  graphics?: BrowserGraphicsDiagnostics | null;
};

/** Browser tab record exposed by tab listing and tab mutation endpoints. */
export type BrowserTab = {
  /** Best handle for agents to pass back as targetId: label, then tabId, then raw targetId. */
  suggestedTargetId?: string;
  targetId: string;
  /** Stable, human-friendly tab handle for this profile runtime (for example t1). */
  tabId?: string;
  /** Optional user-assigned tab label. */
  label?: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

/** Internal tab-open result. Browser tools must remove internal metadata before model output. */
export type BrowserOpenResult = BrowserTab & {
  ownership?: BrowserTabOwnership;
  resolvedProfile?: string;
};

/** ARIA snapshot node exposed in structured snapshot responses. */
export type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};
