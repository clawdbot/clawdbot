import type { MANIFEST_KEY } from "../compat/legacy-names.js";
import type {
  PluginManifestCatalog,
  PluginManifestChannelConfig,
  PluginManifestContracts,
  PluginManifestProviderEndpoint,
} from "./manifest-types.js";
import type {
  OpenClawPackageManifest,
  PluginPackageChannel,
  PluginPackageInstall,
} from "./package-manifest.types.js";

type ManifestKey = typeof MANIFEST_KEY;

export type OfficialExternalProviderAuthChoice = {
  method?: string;
  choiceId?: string;
  deprecatedChoiceIds?: readonly string[];
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation" | "music-generation")[];
};

type OfficialExternalProviderCatalogProvider = {
  id?: string;
  aliases?: readonly string[];
  name?: string;
  docs?: string;
  categories?: readonly string[];
  envVars?: readonly string[];
  authChoices?: readonly OfficialExternalProviderAuthChoice[];
};

export type OfficialExternalWebSearchProvider = {
  id?: string;
  label?: string;
  hint?: string;
  onboardingScopes?: readonly "text-inference"[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars?: readonly string[];
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  credentialPath?: string;
  autoDetectOrder?: number;
};

type OfficialExternalChannelSecretField = {
  field: string;
  activationField?: string;
  activationEnv?: string;
};

export type OfficialExternalChannelSecretContract = {
  channelId: string;
  fields: readonly OfficialExternalChannelSecretField[];
};

type OfficialExternalCatalogChannel = PluginPackageChannel & {
  /** Older hosted catalogs used a flat env list before configuredState became canonical. */
  envVars?: readonly string[];
};

/** Manifest-like metadata stored in official external catalog entries. */
export type OfficialExternalPluginCatalogManifest = {
  legacyPluginIds?: readonly string[];
  legacyNpmPackageNames?: readonly string[];
  setupFeatures?: OpenClawPackageManifest["setupFeatures"];
  plugin?: {
    id?: string;
    label?: string;
  };
  catalog?: PluginManifestCatalog;
  channel?: OfficialExternalCatalogChannel;
  /** Host fallback for external channels that do not yet publish a secret-contract artifact. */
  channelSecrets?: {
    fields?: readonly {
      field?: string;
      activationField?: string;
      activationEnv?: string;
    }[];
  };
  /** Host validation overlays for compatibility-sensitive external channel cutovers. */
  channelHostConfig?: {
    docsSource?: "external" | "official";
    compatibilityMigration?: string;
    schemaAllOf?: readonly Record<string, unknown>[];
  };
  providers?: readonly OfficialExternalProviderCatalogProvider[];
  /**
   * Mirrors the plugin manifest's providerEndpoints so endpoint classification
   * keeps working when the plugin is not installed (dist excludes it).
   */
  providerEndpoints?: readonly PluginManifestProviderEndpoint[];
  webSearchProviders?: readonly OfficialExternalWebSearchProvider[];
  install?: PluginPackageInstall & { sourceRef?: string };
  contracts?: PluginManifestContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

/** Raw official external catalog entry loaded from generated catalog JSON. */
export type OfficialExternalPluginCatalogEntry = {
  id?: string;
  title?: string;
  type?: string;
  state?: string;
  publisher?: {
    id?: string;
    trust?: string;
  };
  name?: string;
  version?: string;
  description?: string;
  icon?: string;
  source?: string;
  kind?: string;
  featured?: boolean;
  featuredAt?: number;
  install?: {
    candidates?: readonly OfficialExternalPluginCatalogInstallCandidate[];
  };
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;

export type OfficialExternalPluginCatalogInstallCandidate = {
  sourceRef?: string;
  package?: string;
  version?: string;
  integrity?: string;
  repo?: string;
  path?: string;
  commit?: string;
};

export type OfficialExternalPluginCatalogSourceProfile =
  | {
      type: "npm";
      registry?: string;
    }
  | {
      type: "clawhub";
      baseUrl?: string;
    }
  | {
      type: "git";
      baseUrl?: string;
    };

type OfficialExternalPluginCatalogFeedProfile = {
  url: string;
  feedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
};

export type OfficialExternalPluginCatalogFeedVerification =
  | {
      mode: "unsigned";
    }
  | {
      mode: "signed";
      keys: readonly OfficialExternalPluginCatalogFeedSigningKey[];
      threshold?: number;
    };

export type OfficialExternalPluginCatalogFeedSigningKey = {
  keyId: string;
  publicKey: string;
};

export type OfficialExternalPluginCatalogProfileConfig = {
  feeds?: Record<string, OfficialExternalPluginCatalogFeedProfile>;
  sources?: Record<string, OfficialExternalPluginCatalogSourceProfile>;
};

/** Feed-shaped wrapper used by the bundled external plugin catalog fallback. */
export type OfficialExternalPluginCatalogFeed = {
  schemaVersion: 1 | 2;
  id: string;
  generatedAt: string;
  expiresAt?: string;
  sequence: number;
  description?: string;
  entries: readonly OfficialExternalPluginCatalogEntry[];
};

export type HostedOfficialExternalPluginCatalogMetadata = {
  url: string;
  status: number;
  etag?: string;
  lastModified?: string;
  checksum: string;
};

export type HostedOfficialExternalPluginCatalogSnapshot = {
  body: string;
  metadata: HostedOfficialExternalPluginCatalogMetadata;
  savedAt: string;
  trust?: HostedOfficialExternalPluginCatalogTrustState;
  monotonic?: HostedOfficialExternalPluginCatalogSnapshotMonotonicState;
};

export type HostedOfficialExternalPluginCatalogSnapshotStore = {
  read: (url: string) => Promise<HostedOfficialExternalPluginCatalogSnapshot | null | undefined>;
  write: (snapshot: HostedOfficialExternalPluginCatalogSnapshot) => Promise<void>;
};

export type HostedOfficialExternalPluginCatalogTrustState = {
  mode: "signed";
  signedBy: string;
  signatureCount: number;
  threshold: number;
  verifiedAt: string;
};

export type HostedOfficialExternalPluginCatalogSnapshotMonotonicState = {
  mode: "signed-feed";
  sequence: number;
  generatedAt?: string;
};

export type HostedOfficialExternalPluginCatalogLoadResult =
  | {
      source: "hosted";
      entries: OfficialExternalPluginCatalogEntry[];
      feed: OfficialExternalPluginCatalogFeed;
      metadata: HostedOfficialExternalPluginCatalogMetadata;
      trust?: HostedOfficialExternalPluginCatalogTrustState;
    }
  | {
      source: "hosted-snapshot";
      entries: OfficialExternalPluginCatalogEntry[];
      feed: OfficialExternalPluginCatalogFeed;
      metadata: HostedOfficialExternalPluginCatalogMetadata;
      snapshot: HostedOfficialExternalPluginCatalogSnapshot;
      trust?: HostedOfficialExternalPluginCatalogTrustState;
      error: string;
    }
  | {
      source: "bundled-fallback";
      entries: OfficialExternalPluginCatalogEntry[];
      error: string;
      metadata?: Omit<HostedOfficialExternalPluginCatalogMetadata, "checksum"> & {
        checksum?: string;
      };
    };
