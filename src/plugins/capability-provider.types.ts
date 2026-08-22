import type { SecretRef } from "../config/types.secrets.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import type { MediaUnderstandingProvider } from "../media-understanding/types.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderId,
  RealtimeVoiceProviderResolveConfigContext,
} from "../talk/provider-types.js";
import type { TranscriptSourceProvider as TranscriptsSourceProviderCapability } from "../transcripts/provider-types.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfiguredContext,
  SpeechProviderConfig,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechListVoicesRequest,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderPreparedSynthesis,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechSynthesisStreamRequest,
  SpeechSynthesisStreamResult,
  SpeechTelephonySynthesisRequest,
  SpeechTelephonySynthesisResult,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import type { PluginJsonValue } from "./host-hooks.js";

/** JSON-compatible provider settings for one configured worker profile. */
export type WorkerProfile = Readonly<Record<string, PluginJsonValue>>;

/** Provider-authored picker metadata for one machine class or exact machine type. */
export type WorkerMachineOption = Readonly<{
  id: string;
  label: string;
  cpu?: number;
  memoryGb?: number;
  default?: boolean;
}>;

/** SSH endpoint material returned by a worker provider after provisioning. */
export type WorkerSshEndpoint = {
  host: string;
  port: number;
  /**
   * Up to 10 ordered unique integer ports (1..65535) after `port`; excludes the primary.
   * Core rotates only for idempotent probes, content-addressed transfers, receipt/lock-guarded
   * artifact installation, convergent managed-worktree mirroring, and tunnel reconnects.
   * Ambiguous unguarded stateful commands fail closed and are not replayed.
   */
  fallbackPorts?: readonly number[];
  user: string;
  /** OpenSSH public host-key line obtained from trusted provisioning output. */
  hostKey: string;
  /** Secret reference only; providers must never return plaintext key material. */
  keyRef: SecretRef;
};

/** Resolved SSH client identity. Providers may return a local path or ephemeral material. */
export type WorkerSshIdentity =
  | { kind: "path"; path: string }
  | { kind: "material"; contents: string };

/** Durable context supplied when a worker provider resolves the identity it minted. */
export type WorkerSshIdentityRequest = {
  leaseId: string;
  profile: WorkerProfile;
  keyRef: SecretRef;
};

/** Closed set of applications installed and launchable on a provisioned worker desktop. */
export type WorkerDesktopApp =
  | {
      id: "browser";
      executablePath: string;
      cdpPort: number;
    }
  | { id: "terminal"; executablePath: string };

/** Optional interactive desktop endpoint provisioned with the lease (warm-time capability). */
export type WorkerDesktopEndpoint = {
  /** Desktop service protocol on the worker loopback; "rfb" is the only phase-1 value. */
  protocol: "rfb";
  /** Loopback port on the worker (e.g. 5900). */
  port: number;
  /** Absolute on-box path to the per-lease password file; read by the owning transport, never persisted as plaintext. */
  passwordFilePath?: string;
  /** Closed application metadata advertised by the provider for this desktop. */
  apps?: WorkerDesktopApp[];
};

/** Placement execution modes a worker provider can carry. */
export type WorkerExecutionMode = "worker-turn" | "remote-exec";

/** Replay-safe node enrollment prepared only after a provider has allocated its machine. */
export type WorkerNodeEnrollment = {
  openclawVersion: string;
  packageSpecs: readonly string[];
  displayName: string;
  /** Gateway shutdown cancels enrollment without releasing its replay-owned provider lease. */
  signal?: AbortSignal;
  waitForDeviceId: () => Promise<string>;
} & (
  | { mode: "connect"; setupCode: string; setupId: string }
  | { mode: "resume"; deviceId: string }
);

/** Durable lease identity and endpoint returned by a successful provision operation. */
export type WorkerLease = {
  leaseId: string;
  /** The SSH account also owns processes unrelated to this worker lease. */
  sharedHost?: boolean;
  desktop?: WorkerDesktopEndpoint;
} & ({ ssh: WorkerSshEndpoint; node?: never } | { node: { deviceId: string }; ssh?: never });

/** Authoritative inspection result for an already-known worker lease. */
export type WorkerLeaseStatus =
  | {
      status: "active";
      /** Explicit provider fact used to reconcile leases persisted before this metadata existed. */
      sharedHost?: boolean;
    }
  | { status: "dormant" }
  | { status: "destroyed" }
  | { status: "unknown" };

/** Provision failed after allocation and the provider could not prove cleanup completed. */
class WorkerProvisionCleanupError extends AggregateError {
  readonly code = "cleanup_indeterminate";
  readonly leaseId: string;

  constructor(
    leaseId: string,
    readonly provisionError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(
      [provisionError, cleanupError],
      "Worker provision failed after allocation and cleanup is indeterminate",
      { cause: provisionError },
    );
    this.name = "WorkerProvisionCleanupError";
    this.leaseId = leaseId.trim();
    if (!this.leaseId) {
      throw new TypeError("Worker provision cleanup lease id must be non-empty");
    }
  }
}

/** Permanent provider rejection recorded as a terminal worker failure. */
export class WorkerProviderError extends Error {
  readonly code = "invalid_profile";

  constructor(message: string) {
    super(message);
    this.name = "WorkerProviderError";
  }

  static cleanupIndeterminate(
    leaseId: string,
    provisionError: unknown,
    cleanupError: unknown,
  ): WorkerProvisionCleanupError {
    return new WorkerProvisionCleanupError(leaseId, provisionError, cleanupError);
  }

  static isCleanupIndeterminate(error: unknown): error is WorkerProvisionCleanupError {
    return error instanceof WorkerProvisionCleanupError;
  }
}

/** Plugin registrations declare exactly one mode; the internal paired-device owner can carry both. */
export type WorkerProvider<Scope extends "plugin" | "internal" = "plugin"> = {
  id: string;
  /** Process-stable choices available for this profile; omit the hook to hide machine selection. */
  listMachineOptions?: (profile: WorkerProfile) => Promise<readonly WorkerMachineOption[]>;
  /** Omission advertises no placement support; external providers declare one transport mode. */
  supportedExecutionModes?: Scope extends "internal"
    ? readonly [WorkerExecutionMode] | readonly ["worker-turn", "remote-exec"]
    : readonly [WorkerExecutionMode];
  /**
   * Provision before preparing an installation when the lease transport decides whether an
   * installation is needed. Defaults to false so SSH providers retain prepare-before-allocation.
   */
  provisionBeforeInstallation?: boolean;
  /** Provider allocates a node host through the environment-owned enrollment callback. */
  requiresNodeEnrollment?: boolean;
  /**
   * Provision or adopt the lease for this operation id.
   * Repeating the same operation id must be idempotent across gateway restarts.
   */
  provision: (
    profile: WorkerProfile,
    operationId: string,
    options?: {
      machineClass?: string;
      beginNodeEnrollment?: () => Promise<WorkerNodeEnrollment>;
    },
  ) => Promise<WorkerLease>;
  /** Maximum core wait for one provision attempt, including provider-owned setup and cleanup. */
  resolveProvisionTimeoutMs?: (profile: WorkerProfile) => number;
  /** Throws on transient/indeterminate failures; `unknown` means authoritative absence. */
  inspect: (lease: { leaseId: string; profile: WorkerProfile }) => Promise<WorkerLeaseStatus>;
  /**
   * Resolves provider-owned dynamic identities. When absent, the gateway uses its generic
   * SecretRef resolver; when present, failures are authoritative and never fall back.
   */
  resolveSshIdentity?: (request: WorkerSshIdentityRequest) => Promise<WorkerSshIdentity>;
  renew?: (leaseId: string) => Promise<void>;
  /** Idempotent; resolves only after the provider can prove teardown. */
  destroy: (lease: { leaseId: string; profile: WorkerProfile }) => Promise<void>;
};

/** Speech capability registered by a plugin. */
export type SpeechProviderPlugin = {
  id: SpeechProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  defaultModel?: string;
  models?: readonly string[];
  voices?: readonly string[];
  resolveConfig?: (ctx: SpeechProviderResolveConfigContext) => SpeechProviderConfig;
  parseDirectiveToken?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  resolveTalkConfig?: (ctx: SpeechProviderResolveTalkConfigContext) => SpeechProviderConfig;
  resolveTalkOverrides?: (
    ctx: SpeechProviderResolveTalkOverridesContext,
  ) => SpeechProviderConfig | undefined;
  prepareSynthesis?: (
    ctx: SpeechProviderPrepareSynthesisContext,
  ) =>
    | SpeechProviderPreparedSynthesis
    | undefined
    | Promise<SpeechProviderPreparedSynthesis | undefined>;
  isConfigured: (ctx: SpeechProviderConfiguredContext) => boolean;
  synthesize: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
  streamSynthesize?: (req: SpeechSynthesisStreamRequest) => Promise<SpeechSynthesisStreamResult>;
  synthesizeTelephony?: (
    req: SpeechTelephonySynthesisRequest,
  ) => Promise<SpeechTelephonySynthesisResult>;
  listVoices?: (req: SpeechListVoicesRequest) => Promise<SpeechVoiceOption[]>;
};

/** Realtime transcription capability registered by a plugin. */
export type RealtimeTranscriptionProviderPlugin = {
  id: RealtimeTranscriptionProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  autoSelectOrder?: number;
  resolveConfig?: (
    ctx: RealtimeTranscriptionProviderResolveConfigContext,
  ) => RealtimeTranscriptionProviderConfig;
  isConfigured: (ctx: RealtimeTranscriptionProviderConfiguredContext) => boolean;
  createSession: (req: RealtimeTranscriptionSessionCreateRequest) => RealtimeTranscriptionSession;
};

/** Transcript source capability registered by a channel or meeting plugin. */
export type TranscriptSourceProvider = TranscriptsSourceProviderCapability;

/** Realtime voice capability registered by a plugin. */
export type RealtimeVoiceProviderPlugin = {
  id: RealtimeVoiceProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  /** Known speaker voices for pickers; providers still accept free-form values. */
  voices?: readonly string[];
  autoSelectOrder?: number;
  capabilities?: RealtimeVoiceProviderCapabilities;
  resolveConfig?: (ctx: RealtimeVoiceProviderResolveConfigContext) => RealtimeVoiceProviderConfig;
  isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => boolean;
  createBridge: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
  createBrowserSession?: (
    req: RealtimeVoiceBrowserSessionCreateRequest,
  ) => Promise<RealtimeVoiceBrowserSession>;
};

export type MediaUnderstandingProviderPlugin = MediaUnderstandingProvider;
export type ImageGenerationProviderPlugin = ImageGenerationProvider;
export type VideoGenerationProviderPlugin = VideoGenerationProvider;
export type MusicGenerationProviderPlugin = MusicGenerationProvider;
