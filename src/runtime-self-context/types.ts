type RuntimeContextSource = "static" | "provider" | "mixed";

export type RuntimeContextExposureMode = "none" | "tool_hint" | "prompt_summary";

type RuntimeContextExposure = {
  mode?: RuntimeContextExposureMode;
};

export type RuntimeContextConfig = {
  source?: RuntimeContextSource;
  expose?: RuntimeContextExposure;
  ttlSeconds?: number;
  validUntil?: string;
  value?: RuntimeSelfContext;
};

export type RuntimeSelfContext = {
  id: string;
  label?: string;
  current?: CurrentRuntime;
  resources?: RuntimeResources;
  limits?: RuntimeLimits;
  actions?: RuntimeActionRef[];
  offload?: RuntimeOffload;
  cost?: RuntimeCostHint;
  freshness?: RuntimeFreshness;
  provenance?: RuntimeProvenance;
};

type CurrentRuntime = {
  id?: string;
  label?: string;
  locality?: "local" | "remote" | "cloud" | "unknown";
  environmentId?: string;
  workspace?: RuntimeWorkspace;
};

type RuntimeWorkspace = {
  mode?: "local" | "mounted" | "synced" | "remote" | "none" | "unknown";
  writable?: boolean;
  cwdRelative?: string;
};

export type RuntimeResources = {
  cpu?: {
    architecture?: string;
    effectiveCores?: number;
    model?: string;
    features?: string[];
  };
  memory?: {
    effectiveBytes?: number;
  };
  disk?: {
    effectiveBytes?: number;
  };
  accelerators?: RuntimeAccelerator[];
};

type RuntimeAccelerator = {
  kind: "gpu" | "npu" | "tpu" | "other";
  vendor?: string;
  model?: string;
  memoryBytes?: number;
  runtimes?: Array<
    "cuda" | "rocm" | "metal" | "opencl" | "vulkan" | "sycl" | "level-zero" | "unknown"
  >;
};

type RuntimeActionKind =
  | "scale_up"
  | "scale_down"
  | "delegate"
  | "provision"
  | "open_session"
  | "submit_task";

type RuntimeLimits = {
  maxTaskSeconds?: number;
  secretsAllowed?: boolean;
  networkAccess?: "enabled" | "disabled" | "restricted" | "unknown";
  filesystemAccess?: "full" | "workspace" | "read_only" | "none" | "unknown";
  approvalRequiredFor?: RuntimeActionKind[];
};

export type RuntimeActionRef = {
  kind: RuntimeActionKind;
  label: string;
  ref: string;
  requiresApproval?: boolean;
  validUntil?: string;
  providerId?: string;
};

type RuntimeOffload = {
  targets?: RuntimeOffloadTarget[];
};

type RuntimeWorkloadKind =
  | "codex"
  | "shell"
  | "build"
  | "test"
  | "long_task"
  | "gpu_compute"
  | "media"
  | "generic";

type RuntimeAvailability = {
  state?: "available" | "unavailable" | "starting" | "stopping" | "error" | "unknown";
  reason?: string;
};

export type RuntimeOffloadTarget = {
  id: string;
  label?: string;
  locality?: "local" | "remote" | "cloud" | "unknown";
  workloadKinds?: RuntimeWorkloadKind[];
  resources?: RuntimeResources;
  limits?: RuntimeLimits;
  availability?: RuntimeAvailability;
  actions?: {
    submitTask?: RuntimeActionRef;
    openSession?: RuntimeActionRef;
    provision?: RuntimeActionRef;
  };
  cost?: RuntimeCostHint;
  validUntil?: string;
  providerId?: string;
};

type RuntimeCostHint = {
  model: "free" | "included" | "metered" | "quota" | "unknown";
  currency?: string;
  roughUnitCost?: string;
  quotaRemaining?: string;
  estimateRef?: string;
  notes?: string;
};

type RuntimeFreshness = {
  observedAt?: string;
  validUntil?: string;
  ttlSeconds?: number;
  stale?: boolean;
};

type RuntimeProvenance = {
  source?: "static_config" | "provider" | "probe" | "operator" | "mixed";
  providerId?: string;
};
