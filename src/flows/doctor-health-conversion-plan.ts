export type DoctorHealthConversionKind =
  | "already-detect"
  | "detect-only"
  | "repair-backed-detect"
  | "split-detect-repair"
  | "runtime-fact"
  | "terminal-side-effect"
  | "interactive-maintenance";

export interface DoctorHealthConversionRule {
  readonly contributionId: string;
  readonly conversion: DoctorHealthConversionKind;
  readonly target: readonly string[];
  readonly rule: string;
}

export const doctorHealthConversionRules = [
  {
    contributionId: "doctor:gateway-config",
    conversion: "already-detect",
    target: ["core/doctor/gateway-config"],
    rule: "Keep as a pure config finding; doctor presentation should render the finding instead of calling note().",
  },
  {
    contributionId: "doctor:auth-profiles",
    conversion: "split-detect-repair",
    target: [
      "core/doctor/auth-profiles/flat-store",
      "core/doctor/auth-profiles/oauth-sidecar",
      "core/doctor/auth-profiles/oauth-ids",
      "core/doctor/auth-profiles/keychain",
      "core/doctor/auth-profiles/codex-provider",
    ],
    rule: "Split each legacy profile repair and keychain prompt into scoped findings; repairs update config only through repair().",
  },
  {
    contributionId: "doctor:claude-cli",
    conversion: "detect-only",
    target: ["core/doctor/claude-cli"],
    rule: "Return CLI readiness findings with install/config hints; no config mutation.",
  },
  {
    contributionId: "doctor:gateway-auth",
    conversion: "repair-backed-detect",
    target: ["core/doctor/gateway-auth"],
    rule: "Detect missing or externally unresolved Gateway auth; repair may generate token only when repair context explicitly allows it.",
  },
  {
    contributionId: "doctor:command-owner",
    conversion: "already-detect",
    target: ["core/doctor/command-owner"],
    rule: "Keep as config-only owner finding.",
  },
  {
    contributionId: "doctor:structured-health-repairs",
    conversion: "terminal-side-effect",
    target: ["doctor-health-repair-runner"],
    rule: "Delete this bridge after converted checks are registered directly; repair orchestration belongs outside the contribution list.",
  },
  {
    contributionId: "doctor:legacy-state",
    conversion: "repair-backed-detect",
    target: ["core/doctor/legacy-state"],
    rule: "Detect migration preview as findings; repair runs selected migrations and reports changes/warnings.",
  },
  {
    contributionId: "doctor:legacy-plugin-manifests",
    conversion: "repair-backed-detect",
    target: ["core/doctor/legacy-plugin-manifests"],
    rule: "Expose manifest contract drift as findings; repair delegates to manifest contract repair.",
  },
  {
    contributionId: "doctor:release-configured-plugin-installs",
    conversion: "repair-backed-detect",
    target: ["core/doctor/configured-plugin-installs"],
    rule: "Detect configured plugins needing release repair; repair may touch meta.lastTouchedVersion and config entries.",
  },
  {
    contributionId: "doctor:plugin-registry",
    conversion: "repair-backed-detect",
    target: ["core/doctor/plugin-registry"],
    rule: "Detect stale plugin registry state and let repair return the next config.",
  },
  {
    contributionId: "doctor:state-integrity",
    conversion: "repair-backed-detect",
    target: ["core/doctor/state-integrity"],
    rule: "Convert orphan/legacy state notes to path-scoped findings; repair archives only selected findings.",
  },
  {
    contributionId: "doctor:codex-session-routes",
    conversion: "repair-backed-detect",
    target: ["core/doctor/codex-session-routes"],
    rule: "Detect stale Codex route pins; repair updates affected session/config route records.",
  },
  {
    contributionId: "doctor:session-locks",
    conversion: "repair-backed-detect",
    target: ["core/doctor/session-locks"],
    rule: "Detect stale session locks; repair removes only the locks represented by findings.",
  },
  {
    contributionId: "doctor:session-transcripts",
    conversion: "repair-backed-detect",
    target: ["core/doctor/session-transcripts"],
    rule: "Detect transcript integrity issues; repair applies scoped transcript cleanup.",
  },
  {
    contributionId: "doctor:session-snapshots",
    conversion: "repair-backed-detect",
    target: ["doctor-run/session-snapshots"],
    rule: "Keep this on the legacy doctor run path until the session snapshot scanner has a structured detector; do not register a clean core lint target before then.",
  },
  {
    contributionId: "doctor:config-audit-scrub",
    conversion: "repair-backed-detect",
    target: ["core/doctor/config-audit-scrub"],
    rule: "Detect scrub-needed audit entries; repair rewrites only matching audit records.",
  },
  {
    contributionId: "doctor:legacy-cron",
    conversion: "split-detect-repair",
    target: ["core/doctor/legacy-cron-store", "core/doctor/legacy-whatsapp-crontab"],
    rule: "Split crontab warning from cron store migration; repair only mutates cron store findings.",
  },
  {
    contributionId: "doctor:sandbox",
    conversion: "split-detect-repair",
    target: [
      "core/doctor/sandbox/registry-files",
      "core/doctor/sandbox/images",
      "core/doctor/sandbox-scope",
    ],
    rule: "Separate registry/image repairs from read-only sandbox scope warnings.",
  },
  {
    contributionId: "doctor:gateway-services",
    conversion: "split-detect-repair",
    target: [
      "core/doctor/gateway-services/extra",
      "core/doctor/gateway-services/config",
      "core/doctor/gateway-services/platform-notes",
    ],
    rule: "Model scans as findings; repair service config only when repair policy permits.",
  },
  {
    contributionId: "doctor:startup-channel-maintenance",
    conversion: "repair-backed-detect",
    target: ["core/doctor/startup-channel-maintenance"],
    rule: "Detect startup channel maintenance work and run repair through the existing maintenance helper.",
  },
  {
    contributionId: "doctor:security",
    conversion: "detect-only",
    target: ["core/doctor/security"],
    rule: "Return security posture warnings as findings with fix hints.",
  },
  {
    contributionId: "doctor:browser",
    conversion: "detect-only",
    target: ["core/doctor/browser"],
    rule: "Return Chrome/MCP readiness findings without launching or repairing browser state.",
  },
  {
    contributionId: "doctor:oauth-tls",
    conversion: "detect-only",
    target: ["core/doctor/oauth-tls"],
    rule: "Expose OAuth TLS prerequisites as findings; preserve deep-mode detail as finding metadata.",
  },
  {
    contributionId: "doctor:hooks-model",
    conversion: "detect-only",
    target: ["core/doctor/hooks-model"],
    rule: "Detect allowlist/catalog issues for hooks.gmail.model as config findings.",
  },
  {
    contributionId: "doctor:tool-result-cap",
    conversion: "detect-only",
    target: ["core/doctor/tool-result-cap"],
    rule: "Detect explicit live tool-result cap overrides that are stale or ineffective; preserve deep-mode effective cap output as finding metadata.",
  },
  {
    contributionId: "doctor:runtime-tool-schemas",
    conversion: "detect-only",
    target: ["core/doctor/runtime-tool-schemas"],
    rule: "Validate active agent tool schemas against the runtime tool projection path and report fatal schema blockers before a turn starts.",
  },
  {
    contributionId: "doctor:systemd-linger",
    conversion: "interactive-maintenance",
    target: ["core/doctor/systemd-linger"],
    rule: "Detect missing linger as a Linux-only finding; interactive enablement remains a repair prompt.",
  },
  {
    contributionId: "doctor:workspace-status",
    conversion: "already-detect",
    target: ["core/doctor/workspace-status"],
    rule: "Keep legacy workspace directory detection as a pure finding.",
  },
  {
    contributionId: "doctor:skills",
    conversion: "already-detect",
    target: ["core/doctor/skills-readiness"],
    rule: "Keep unavailable skill detection/disable repair in the health registry.",
  },
  {
    contributionId: "doctor:bootstrap-size",
    conversion: "detect-only",
    target: ["core/doctor/bootstrap-size"],
    rule: "Return oversized bootstrap files as path findings.",
  },
  {
    contributionId: "doctor:shell-completion",
    conversion: "interactive-maintenance",
    target: ["core/doctor/shell-completion"],
    rule: "Detect stale/missing completion setup; repair can delegate to completion installer when interactive.",
  },
  {
    contributionId: "doctor:gateway-health",
    conversion: "runtime-fact",
    target: ["doctor-runtime/gateway-status", "doctor-runtime/gateway-memory-probe"],
    rule: "Prepare shared Gateway status/memory facts before checks; dependent checks must consume facts instead of probing again.",
  },
  {
    contributionId: "doctor:whatsapp-responsiveness",
    conversion: "detect-only",
    target: ["core/doctor/whatsapp-responsiveness"],
    rule: "Detect WhatsApp degraded responsiveness from prepared Gateway status.",
  },
  {
    contributionId: "doctor:memory-search",
    conversion: "split-detect-repair",
    target: [
      "core/doctor/memory-search",
      "core/doctor/memory-recall",
      "core/doctor/memory-gateway-probe",
    ],
    rule: "Use prepared memory probe facts; keep recall repair separate from read-only search findings.",
  },
  {
    contributionId: "doctor:device-pairing",
    conversion: "detect-only",
    target: ["core/doctor/device-pairing"],
    rule: "Report pairing readiness from prepared Gateway health facts.",
  },
  {
    contributionId: "doctor:gateway-daemon",
    conversion: "repair-backed-detect",
    target: ["core/doctor/gateway-daemon"],
    rule: "Detect daemon drift from Gateway facts; repair delegates to daemon flow with scoped findings.",
  },
  {
    contributionId: "doctor:write-config",
    conversion: "terminal-side-effect",
    target: ["doctor-config-persistence"],
    rule: "Keep config persistence as the final write step after repairs; it is not a health check.",
  },
  {
    contributionId: "doctor:workspace-suggestions",
    conversion: "detect-only",
    target: ["core/doctor/workspace-suggestions"],
    rule: "Return workspace backup/memory-system suggestions as info findings when suggestions are enabled.",
  },
  {
    contributionId: "doctor:final-config-validation",
    conversion: "already-detect",
    target: ["core/doctor/final-config-validation"],
    rule: "Keep final schema validation as a registered core check.",
  },
] as const satisfies readonly DoctorHealthConversionRule[];
