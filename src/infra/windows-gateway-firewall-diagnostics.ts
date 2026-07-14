// Read-only diagnostics for Windows LAN Gateway reachability.
import { runCommandWithTimeout as defaultRunCommandWithTimeout } from "../process/exec.js";
import { getWindowsPowerShellExePath, getWindowsSystem32ExePath } from "./windows-install-roots.js";

const DEFAULT_WINDOWS_GATEWAY_FIREWALL_TIMEOUT_MS = 5_000;
const QUICK_WINDOWS_GATEWAY_FIREWALL_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024;
const WINDOWS_MANAGED_FIREWALL_POLICY_SOURCE_TYPES = [
  "GroupPolicy",
  "Dynamic",
  "Generated",
  "Hardcoded",
  "MDM",
  "HostFirewallGroupPolicy",
  "HostFirewallDynamic",
  "HostFirewallMDM",
];

const WINDOWS_FIREWALL_STATE_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$connections = Get-NetConnectionProfile | Select-Object InterfaceAlias, @{Name='NetworkCategory';Expression={$_.NetworkCategory.ToString()}}",
  "$activeProfiles = Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, @{Name='Enabled';Expression={$_.Enabled.ToString()}}, @{Name='DefaultInboundAction';Expression={$_.DefaultInboundAction.ToString()}}, @{Name='AllowInboundRules';Expression={$_.AllowInboundRules.ToString()}}, @{Name='AllowLocalFirewallRules';Expression={$_.AllowLocalFirewallRules.ToString()}}",
  "$localProfiles = Get-NetFirewallProfile -PolicyStore localhost | Select-Object Name, @{Name='Enabled';Expression={$_.Enabled.ToString()}}, @{Name='DefaultInboundAction';Expression={$_.DefaultInboundAction.ToString()}}, @{Name='AllowInboundRules';Expression={$_.AllowInboundRules.ToString()}}, @{Name='AllowLocalFirewallRules';Expression={$_.AllowLocalFirewallRules.ToString()}}",
  "[pscustomobject]@{ConnectionProfiles = $connections; ActiveFirewallProfiles = $activeProfiles; LocalFirewallProfiles = $localProfiles} | ConvertTo-Json -Depth 4 -Compress",
].join("\n");

function buildWindowsNetSecurityFirewallRulesCommand(
  port: number,
  policyStore: "ActiveStore" | "PersistentStore",
  policyStoreSourceTypes?: readonly string[],
): string {
  const sourceTypeNames = policyStoreSourceTypes?.map((name) => `'${name}'`).join(", ");
  const sourceTypeSetup = sourceTypeNames
    ? `
$policyStoreSourceType = (Get-Command Get-NetFirewallRule).Parameters['PolicyStoreSourceType'].ParameterType.GetElementType()
$requestedPolicyStoreSourceTypes = @(${sourceTypeNames})
$supportedPolicyStoreSourceTypes = [enum]::GetNames($policyStoreSourceType)
$policyStoreSourceTypes = @(
  foreach ($requestedPolicyStoreSourceType in $requestedPolicyStoreSourceTypes) {
    $supportedPolicyStoreSourceTypes | Where-Object { $_ -ieq $requestedPolicyStoreSourceType } | Select-Object -First 1
  }
)
`
    : "";
  const ruleQuery = sourceTypeNames
    ? `
$rules = if ($policyStoreSourceTypes.Count -gt 0) {
  @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -PolicyStore ${policyStore} -PolicyStoreSourceType $policyStoreSourceTypes -ErrorAction SilentlyContinue)
} else {
  @()
}
`
    : `
$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -PolicyStore ${policyStore})
`;
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetPort = ${port}
${sourceTypeSetup}
function Test-OpenClawPortMatch($value) {
  foreach ($entry in @($value)) {
    $text = ([string]$entry).Trim()
    if ($text -eq 'Any') { return $true }
    foreach ($part in $text -split ',') {
      $range = $part.Trim()
      if ($range -eq ([string]$targetPort)) { return $true }
      if ($range -match '^(\\d+)-(\\d+)$') {
        $start = [int]$Matches[1]
        $end = [int]$Matches[2]
        if ($start -le $targetPort -and $targetPort -le $end) { return $true }
      }
    }
  }
  return $false
}
${ruleQuery}
$matchingRules = New-Object System.Collections.ArrayList
foreach ($rule in $rules) {
  foreach ($portFilter in @($rule | Get-NetFirewallPortFilter)) {
    $protocol = $portFilter.Protocol.ToString()
    if (($protocol -eq 'Any' -or $protocol -eq 'TCP') -and (Test-OpenClawPortMatch $portFilter.LocalPort)) {
      $appFilter = $rule | Get-NetFirewallApplicationFilter
      $addressFilter = $rule | Get-NetFirewallAddressFilter
      [void]$matchingRules.Add([pscustomobject]@{
        DisplayName = [string]$rule.DisplayName
        Name = [string]$rule.Name
        Profile = [string]$rule.Profile
        PolicyStoreSource = [string]$rule.PolicyStoreSource
        PolicyStoreSourceType = $rule.PolicyStoreSourceType.ToString()
        Program = [string]$appFilter.Program
        LocalAddress = [string]$addressFilter.LocalAddress
        RemoteAddress = [string]$addressFilter.RemoteAddress
      })
    }
  }
}
$matchingRules | ConvertTo-Json -Depth 4 -Compress
`.trim();
}

function buildWindowsPersistentFirewallRulesCommand(port: number): string {
  return buildWindowsNetSecurityFirewallRulesCommand(port, "PersistentStore");
}

function buildWindowsManagedActiveFirewallRulesCommand(port: number): string {
  return buildWindowsNetSecurityFirewallRulesCommand(
    port,
    "ActiveStore",
    WINDOWS_MANAGED_FIREWALL_POLICY_SOURCE_TYPES,
  );
}

function buildWindowsFirewallRulesCommand(port: number): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetPort = ${port}
function Test-OpenClawPortMatch($value) {
  $text = ([string]$value).Trim()
  if ($text -eq '' -or $text -eq '*') { return $true }
  foreach ($part in $text -split ',') {
    $range = $part.Trim()
    if ($range -eq ([string]$targetPort)) { return $true }
    if ($range -match '^(\\d+)-(\\d+)$') {
      $start = [int]$Matches[1]
      $end = [int]$Matches[2]
      if ($start -le $targetPort -and $targetPort -le $end) { return $true }
    }
  }
  return $false
}
function Resolve-OpenClawProgramScope($rule) {
  $program = ([string]$rule.ApplicationName).Trim()
  if ($program) { return $program }
  foreach ($field in @('serviceName', 'LocalAppPackageId', 'LocalUserOwner')) {
    $value = ([string]$rule.$field).Trim()
    if ($value) { return $value }
  }
  $ports = ([string]$rule.LocalPorts).Trim()
  if ($ports -ne '' -and $ports -ne '*') { return 'Any' }
  return 'Any'
}
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$matchingRules = New-Object System.Collections.ArrayList
foreach ($rule in $policy.Rules) {
  if (-not $rule.Enabled -or $rule.Direction -ne 1 -or $rule.Action -ne 1) { continue }
  $protocol = if ($rule.Protocol -eq 6) { 'TCP' } elseif ($rule.Protocol -eq 256) { 'Any' } else { [string]$rule.Protocol }
  if (($protocol -ne 'TCP' -and $protocol -ne 'Any') -or -not (Test-OpenClawPortMatch $rule.LocalPorts)) { continue }
  [void]$matchingRules.Add([pscustomobject]@{
    DisplayName = [string]$rule.Name
    Name = [string]$rule.Name
    Profile = [string]$rule.Profiles
    PolicyStoreSource = 'PersistentStore'
    PolicyStoreSourceType = 'Local'
    Program = (Resolve-OpenClawProgramScope $rule)
    LocalAddress = [string]$rule.LocalAddresses
    RemoteAddress = [string]$rule.RemoteAddresses
  })
}
$matchingRules | ConvertTo-Json -Depth 4 -Compress
`.trim();
}

function buildWindowsQuickFirewallCommand(port: number): string {
  const sourceTypeNames = WINDOWS_MANAGED_FIREWALL_POLICY_SOURCE_TYPES.map(
    (name) => `'${name}'`,
  ).join(", ");
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targetPort = ${port}
function Test-OpenClawPortMatch($value) {
  foreach ($entry in @($value)) {
    $text = ([string]$entry).Trim()
    if ($text -eq '' -or $text -eq '*' -or $text -eq 'Any') { return $true }
    foreach ($part in $text -split ',') {
      $range = $part.Trim()
      if ($range -eq ([string]$targetPort)) { return $true }
      if ($range -match '^(\\d+)-(\\d+)$') {
        $start = [int]$Matches[1]
        $end = [int]$Matches[2]
        if ($start -le $targetPort -and $targetPort -le $end) { return $true }
      }
    }
  }
  return $false
}
function Resolve-OpenClawProgramScope($rule) {
  $program = ([string]$rule.ApplicationName).Trim()
  if ($program) { return $program }
  foreach ($field in @('serviceName', 'LocalAppPackageId', 'LocalUserOwner')) {
    $value = ([string]$rule.$field).Trim()
    if ($value) { return $value }
  }
  $ports = ([string]$rule.LocalPorts).Trim()
  if ($ports -ne '' -and $ports -ne '*') { return 'Any' }
  return 'Any'
}
function Get-OpenClawManagedRules {
  try {
    $getRule = Get-Command Get-NetFirewallRule -ErrorAction Stop
    $sourceTypeParameter = $getRule.Parameters['PolicyStoreSourceType']
    if ($null -eq $sourceTypeParameter) { return @() }
    $sourceType = $sourceTypeParameter.ParameterType
    if ($sourceType.IsArray) { $sourceType = $sourceType.GetElementType() }
    $requestedPolicyStoreSourceTypes = @(${sourceTypeNames})
    $supportedPolicyStoreSourceTypes = [enum]::GetNames($sourceType)
    $policyStoreSourceTypes = @(
      foreach ($requestedPolicyStoreSourceType in $requestedPolicyStoreSourceTypes) {
        $supportedPolicyStoreSourceTypes | Where-Object { $_ -ieq $requestedPolicyStoreSourceType } | Select-Object -First 1
      }
    )
    if ($policyStoreSourceTypes.Count -eq 0) { return @() }
    $rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -PolicyStore ActiveStore -PolicyStoreSourceType $policyStoreSourceTypes -ErrorAction SilentlyContinue)
    $matchingRules = New-Object System.Collections.ArrayList
    foreach ($rule in $rules) {
      foreach ($portFilter in @($rule | Get-NetFirewallPortFilter)) {
        $protocol = $portFilter.Protocol.ToString()
        if (($protocol -eq 'Any' -or $protocol -eq 'TCP') -and (Test-OpenClawPortMatch $portFilter.LocalPort)) {
          $appFilter = $rule | Get-NetFirewallApplicationFilter
          $addressFilter = $rule | Get-NetFirewallAddressFilter
          [void]$matchingRules.Add([pscustomobject]@{
            DisplayName = [string]$rule.DisplayName
            Name = [string]$rule.Name
            Profile = [string]$rule.Profile
            PolicyStoreSource = [string]$rule.PolicyStoreSource
            PolicyStoreSourceType = $rule.PolicyStoreSourceType.ToString()
            Program = [string]$appFilter.Program
            LocalAddress = [string]$addressFilter.LocalAddress
            RemoteAddress = [string]$addressFilter.RemoteAddress
          })
        }
      }
    }
    return $matchingRules
  } catch {
    return @()
  }
}
$connections = Get-NetConnectionProfile | Select-Object InterfaceAlias, @{Name='NetworkCategory';Expression={$_.NetworkCategory.ToString()}}
$activeProfiles = Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, @{Name='Enabled';Expression={$_.Enabled.ToString()}}, @{Name='DefaultInboundAction';Expression={$_.DefaultInboundAction.ToString()}}, @{Name='AllowInboundRules';Expression={$_.AllowInboundRules.ToString()}}, @{Name='AllowLocalFirewallRules';Expression={$_.AllowLocalFirewallRules.ToString()}}
$localProfiles = Get-NetFirewallProfile -PolicyStore localhost | Select-Object Name, @{Name='Enabled';Expression={$_.Enabled.ToString()}}, @{Name='DefaultInboundAction';Expression={$_.DefaultInboundAction.ToString()}}, @{Name='AllowInboundRules';Expression={$_.AllowInboundRules.ToString()}}, @{Name='AllowLocalFirewallRules';Expression={$_.AllowLocalFirewallRules.ToString()}}
$managedMatchingRules = @(Get-OpenClawManagedRules)
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$matchingRules = New-Object System.Collections.ArrayList
foreach ($rule in $policy.Rules) {
  if (-not $rule.Enabled -or $rule.Direction -ne 1 -or $rule.Action -ne 1) { continue }
  $protocol = if ($rule.Protocol -eq 6) { 'TCP' } elseif ($rule.Protocol -eq 256) { 'Any' } else { [string]$rule.Protocol }
  if (($protocol -ne 'TCP' -and $protocol -ne 'Any') -or -not (Test-OpenClawPortMatch $rule.LocalPorts)) { continue }
  [void]$matchingRules.Add([pscustomobject]@{
    DisplayName = [string]$rule.Name
    Name = [string]$rule.Name
    Profile = [string]$rule.Profiles
    PolicyStoreSource = 'PersistentStore'
    PolicyStoreSourceType = 'Local'
    Program = (Resolve-OpenClawProgramScope $rule)
    LocalAddress = [string]$rule.LocalAddresses
    RemoteAddress = [string]$rule.RemoteAddresses
  })
}
[pscustomobject]@{
  State = [pscustomobject]@{
    ConnectionProfiles = $connections
    ActiveFirewallProfiles = $activeProfiles
    LocalFirewallProfiles = $localProfiles
  }
  ActiveRules = $managedMatchingRules
  LocalRules = $matchingRules
} | ConvertTo-Json -Depth 5 -Compress
`.trim();
}

type WindowsGatewayFirewallDiagnosticCode =
  | "windows_firewall_not_applicable"
  | "windows_firewall_unrestricted"
  | "windows_firewall_rule_present"
  | "windows_firewall_rule_profile_mismatch"
  | "windows_firewall_program_scoped_rule_unverified"
  | "windows_firewall_address_scoped_rule_unverified"
  | "windows_firewall_inbound_rules_disabled"
  | "windows_firewall_local_rules_ignored"
  | "windows_firewall_no_allow_rule"
  | "windows_firewall_inspection_failed";

export type WindowsGatewayFirewallDiagnostic = {
  applies: boolean;
  severity: "info" | "warning";
  code: WindowsGatewayFirewallDiagnosticCode;
  message: string;
  details: string[];
};

type WindowsGatewayFirewallCommandResult = {
  code: number | null;
  stdout: string;
  stderr?: string;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
};

type WindowsGatewayFirewallCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number },
) => Promise<WindowsGatewayFirewallCommandResult>;

type InspectWindowsGatewayFirewallParams = {
  bind: string | undefined;
  port: number;
  mode?: "quick" | "full";
  platform?: NodeJS.Platform;
  runCommandWithTimeout?: WindowsGatewayFirewallCommandRunner;
  timeoutMs?: number;
};

type FirewallStatePayload = {
  ConnectionProfiles?: unknown;
  ActiveFirewallProfiles?: unknown;
  LocalFirewallProfiles?: unknown;
};

type FirewallProfile = {
  name: string;
  enabled: string;
  defaultInboundAction: string;
  allowInboundRules: string;
  allowLocalFirewallRules: string;
};

type FirewallRule = {
  displayName: string;
  profile: string;
  policyStoreSource: string;
  policyStoreSourceType: string;
  program: string;
  localAddress: string;
  remoteAddress: string;
};

type ClassifiedFirewallState = {
  activeProfileNames: string[];
  activeProfiles: FirewallProfile[];
  localProfiles: FirewallProfile[];
  matchingRules: FirewallRule[];
  localMatchingRules: FirewallRule[];
  netshOutput: string;
};

type QuickFirewallPayload = {
  State?: unknown;
  ActiveRules?: unknown;
  LocalRules?: unknown;
};

function powershell(command: string): string[] {
  return [
    getWindowsPowerShellExePath(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];
}

async function runBestEffortCommand(
  runCommandWithTimeout: WindowsGatewayFirewallCommandRunner,
  argv: string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs,
      maxOutputBytes: DEFAULT_OUTPUT_BYTES,
    });
    if ((result.stdoutTruncatedBytes ?? 0) > 0 || (result.stderrTruncatedBytes ?? 0) > 0) {
      return null;
    }
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

function parseJsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value && typeof value === "object" ? [value] : [];
}

function parseJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function normalizeProfileName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "domainauthenticated") {
    return "domain";
  }
  return normalized;
}

function parseFirewallProfiles(value: unknown): FirewallProfile[] {
  return parseJsonRows(value)
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      name: normalizeProfileName(stringField(row, "Name")),
      enabled: stringField(row, "Enabled").toLowerCase(),
      defaultInboundAction: stringField(row, "DefaultInboundAction").toLowerCase(),
      allowInboundRules: stringField(row, "AllowInboundRules").toLowerCase(),
      allowLocalFirewallRules: stringField(row, "AllowLocalFirewallRules").toLowerCase(),
    }))
    .filter((profile) => profile.name.length > 0);
}

function parseConnectionProfileNames(value: unknown): string[] {
  const names = parseJsonRows(value)
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => normalizeProfileName(stringField(row, "NetworkCategory")))
    .filter(Boolean);
  return [...new Set(names)];
}

function parseFirewallRules(value: unknown): FirewallRule[] {
  return parseJsonRows(value)
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      displayName:
        stringField(row, "DisplayName") ||
        stringField(row, "displayName") ||
        stringField(row, "Name") ||
        "unnamed rule",
      profile: (stringField(row, "Profile") || stringField(row, "profile")).toLowerCase(),
      policyStoreSource: (
        stringField(row, "PolicyStoreSource") || stringField(row, "policyStoreSource")
      ).toLowerCase(),
      policyStoreSourceType: (
        stringField(row, "PolicyStoreSourceType") || stringField(row, "policyStoreSourceType")
      ).toLowerCase(),
      program: (stringField(row, "Program") || stringField(row, "program")).toLowerCase(),
      localAddress: (
        stringField(row, "LocalAddress") || stringField(row, "localAddress")
      ).toLowerCase(),
      remoteAddress: (
        stringField(row, "RemoteAddress") || stringField(row, "remoteAddress")
      ).toLowerCase(),
    }));
}

function isTruthyFirewallValue(value: string): boolean {
  return value === "true" || value === "allow" || value === "1";
}

function isBlockingInbound(profile: FirewallProfile): boolean {
  return profile.enabled !== "false" && profile.defaultInboundAction !== "allow";
}

function inboundRulesAreAllowed(profiles: FirewallProfile[]): boolean {
  return profiles.every((profile) => profile.allowInboundRules !== "false");
}

function findProfileSettings(
  profiles: FirewallProfile[],
  activeProfileNames: string[],
): FirewallProfile[] {
  if (activeProfileNames.length === 0) {
    return profiles;
  }
  return profiles.filter((profile) => activeProfileNames.includes(profile.name));
}

function profileMaskMatches(value: number, activeProfileNames: string[]): boolean {
  const masks: Record<string, number> = {
    domain: 1,
    private: 2,
    public: 4,
  };
  return activeProfileNames.some((name) => (value & (masks[name] ?? 0)) !== 0);
}

function ruleMatchesActiveProfile(rule: FirewallRule, activeProfileNames: string[]): boolean {
  if (activeProfileNames.length === 0) {
    return true;
  }
  const profile = rule.profile;
  if (!profile || profile === "any" || profile === "all") {
    return true;
  }
  const numeric = Number.parseInt(profile, 10);
  if (Number.isFinite(numeric)) {
    return profileMaskMatches(numeric, activeProfileNames);
  }
  return activeProfileNames.some((name) => profile.includes(name));
}

function isLocalRule(rule: FirewallRule): boolean {
  return (
    !rule.policyStoreSourceType ||
    rule.policyStoreSourceType === "local" ||
    rule.policyStoreSourceType === "persistentstore" ||
    rule.policyStoreSource === "persistentstore"
  );
}

function isProgramAgnosticRule(rule: FirewallRule): boolean {
  return !rule.program || rule.program === "any";
}

function isAnyAddress(value: string): boolean {
  return !value || value === "any" || value === "*";
}

function isAddressAgnosticRule(rule: FirewallRule): boolean {
  return isAnyAddress(rule.localAddress) && isAnyAddress(rule.remoteAddress);
}

function localRulesAreAllowed(params: {
  activeProfileNames: string[];
  activeProfiles: FirewallProfile[];
  localProfiles: FirewallProfile[];
}): boolean {
  const activeProfiles = findProfileSettings(params.activeProfiles, params.activeProfileNames);
  const explicitActiveProfiles = activeProfiles.filter(
    (profile) =>
      profile.allowLocalFirewallRules && profile.allowLocalFirewallRules !== "notconfigured",
  );
  if (explicitActiveProfiles.length > 0) {
    return explicitActiveProfiles.every((profile) =>
      isTruthyFirewallValue(profile.allowLocalFirewallRules),
    );
  }

  const localProfiles = findProfileSettings(params.localProfiles, params.activeProfileNames);
  const explicitLocalProfiles = localProfiles.filter(
    (profile) =>
      profile.allowLocalFirewallRules && profile.allowLocalFirewallRules !== "notconfigured",
  );
  if (explicitLocalProfiles.length > 0) {
    return explicitLocalProfiles.every((profile) =>
      isTruthyFirewallValue(profile.allowLocalFirewallRules),
    );
  }

  return true;
}

function formatProfiles(activeProfileNames: string[]): string {
  return activeProfileNames.length > 0 ? activeProfileNames.join(", ") : "unknown";
}

function formatRuleNames(rules: FirewallRule[]): string {
  return rules
    .map((rule) => rule.displayName)
    .filter(Boolean)
    .join(", ");
}

function classifyWindowsGatewayFirewallState(
  state: ClassifiedFirewallState,
): WindowsGatewayFirewallDiagnostic {
  const activeProfiles = findProfileSettings(state.activeProfiles, state.activeProfileNames);
  const blockingProfiles = activeProfiles.filter(isBlockingInbound);
  const matchingActiveRules = state.matchingRules.filter((rule) =>
    ruleMatchesActiveProfile(rule, state.activeProfileNames),
  );
  const programAgnosticMatchingRules = matchingActiveRules.filter(
    (rule) => isProgramAgnosticRule(rule) && isAddressAgnosticRule(rule),
  );
  const programScopedMatchingRules = matchingActiveRules.filter(
    (rule) => !isProgramAgnosticRule(rule),
  );
  const addressScopedMatchingRules = matchingActiveRules.filter(
    (rule) => isProgramAgnosticRule(rule) && !isAddressAgnosticRule(rule),
  );
  const localMatchingRules = state.localMatchingRules.filter((rule) =>
    ruleMatchesActiveProfile(rule, state.activeProfileNames),
  );
  const programAgnosticLocalRules = localMatchingRules.filter(
    (rule) => isProgramAgnosticRule(rule) && isAddressAgnosticRule(rule),
  );
  const mismatchedRules = state.matchingRules.filter(
    (rule) => !ruleMatchesActiveProfile(rule, state.activeProfileNames),
  );
  const activeProfileText = formatProfiles(state.activeProfileNames);

  if (activeProfiles.length > 0 && blockingProfiles.length === 0) {
    return {
      applies: true,
      severity: "info",
      code: "windows_firewall_unrestricted",
      message:
        "Windows Firewall is not blocking unsolicited inbound traffic on the active profile.",
      details: [`Active network profile: ${activeProfileText}.`],
    };
  }

  if (programAgnosticMatchingRules.length > 0) {
    if (!inboundRulesAreAllowed(activeProfiles)) {
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_inbound_rules_disabled",
        message:
          "Windows Firewall is configured to block inbound connections even when allow rules exist.",
        details: [
          `Active network profile: ${activeProfileText}.`,
          `Matching allow rule(s): ${formatRuleNames(programAgnosticMatchingRules)}.`,
          "Enable inbound rules for the active Windows Firewall profile, or use loopback, Tailscale, or an SSH tunnel instead of LAN binding.",
        ],
      };
    }
    const localRules = programAgnosticMatchingRules.filter(isLocalRule);
    const onlyLocalRules = localRules.length === programAgnosticMatchingRules.length;
    if (onlyLocalRules && !localRulesAreAllowed(state)) {
      const policyDetail = /gpo-store only/i.test(state.netshOutput)
        ? "Windows reports LocalFirewallRules as N/A (GPO-store only)."
        : "Local firewall rules are not explicitly enabled for the active profile.";
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_local_rules_ignored",
        message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
        details: [
          `Active network profile: ${activeProfileText}.`,
          `Matching local allow rule(s): ${formatRuleNames(programAgnosticMatchingRules)}.`,
          policyDetail,
          "Use a Group Policy/administrator-managed inbound TCP allow rule for the Gateway port, or switch to a network path such as loopback, Tailscale, or an SSH tunnel.",
        ],
      };
    }
    return {
      applies: true,
      severity: "info",
      code: "windows_firewall_rule_present",
      message:
        "Windows Firewall has an inbound TCP allow rule for the Gateway port on the active profile.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        `Matching allow rule(s): ${formatRuleNames(programAgnosticMatchingRules)}.`,
        "If another device still cannot connect, verify the advertised LAN URL from that device.",
      ],
    };
  }

  if (programScopedMatchingRules.length > 0) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_program_scoped_rule_unverified",
      message:
        "Windows Firewall has a matching port allow rule, but it is scoped to a specific program.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        `Program-scoped allow rule(s): ${formatRuleNames(programScopedMatchingRules)}.`,
        "Create an inbound TCP allow rule for the Gateway port that is not scoped to another executable, or verify the advertised LAN URL from another device.",
      ],
    };
  }

  if (addressScopedMatchingRules.length > 0) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_address_scoped_rule_unverified",
      message:
        "Windows Firewall has a matching port allow rule, but it is scoped to specific addresses.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        `Address-scoped allow rule(s): ${formatRuleNames(addressScopedMatchingRules)}.`,
        "Create an inbound TCP allow rule for the Gateway port that covers LAN clients, or verify the advertised LAN URL from another device.",
      ],
    };
  }

  if (programAgnosticLocalRules.length > 0 && !localRulesAreAllowed(state)) {
    const policyDetail = /gpo-store only/i.test(state.netshOutput)
      ? "Windows reports LocalFirewallRules as N/A (GPO-store only)."
      : "Local firewall rules are disabled for the active profile.";
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
      message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        `Matching local allow rule(s): ${formatRuleNames(programAgnosticLocalRules)}.`,
        policyDetail,
        "Use a Group Policy/administrator-managed inbound TCP allow rule for the Gateway port, or switch to a network path such as loopback, Tailscale, or an SSH tunnel.",
      ],
    };
  }

  if (mismatchedRules.length > 0) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_rule_profile_mismatch",
      message: "Windows Firewall has a Gateway allow rule, but not for the active network profile.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        `Mismatched allow rule(s): ${formatRuleNames(mismatchedRules)}.`,
        "Create or update an inbound TCP allow rule for the active profile, or change the Windows network profile intentionally.",
      ],
    };
  }

  if (!localRulesAreAllowed(state) && state.localMatchingRules.length === 0) {
    const policyDetail = /gpo-store only/i.test(state.netshOutput)
      ? "Windows reports LocalFirewallRules as N/A (GPO-store only)."
      : "Local firewall rules are disabled for the active profile.";
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
      message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        "No active inbound TCP allow rule for the Gateway port was found.",
        policyDetail,
        "Use a Group Policy/administrator-managed inbound TCP allow rule for the Gateway port, or switch to a network path such as loopback, Tailscale, or an SSH tunnel.",
      ],
    };
  }

  if (blockingProfiles.length > 0 || activeProfiles.length === 0) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_no_allow_rule",
      message: "Windows Firewall is likely blocking LAN devices from reaching the Gateway port.",
      details: [
        `Active network profile: ${activeProfileText}.`,
        "No enabled inbound TCP allow rule for the Gateway port was found in the active firewall policy.",
        "Allow the Gateway port in Windows Firewall, or use loopback, Tailscale, or an SSH tunnel instead of LAN binding.",
      ],
    };
  }

  return {
    applies: true,
    severity: "info",
    code: "windows_firewall_unrestricted",
    message: "Windows Firewall did not show a blocking active profile for the Gateway port.",
    details: [`Active network profile: ${activeProfileText}.`],
  };
}

function buildClassifiedState(
  stateJson: string,
  netshOutput: string,
  activeRules: FirewallRule[],
  localRules: FirewallRule[],
): ClassifiedFirewallState | null {
  return parseWindowsGatewayFirewallState({
    stateJson,
    rulesJson: JSON.stringify({
      ActiveRules: activeRules,
      LocalRules: localRules,
    }),
    netshOutput,
  });
}

function shouldProbeManagedActiveRules(diagnostic: WindowsGatewayFirewallDiagnostic): boolean {
  return (
    diagnostic.severity === "warning" &&
    diagnostic.code !== "windows_firewall_inbound_rules_disabled"
  );
}

function parseWindowsGatewayFirewallState(params: {
  stateJson: string;
  rulesJson: string;
  netshOutput?: string | null;
}): ClassifiedFirewallState | null {
  const state = parseJsonPayload(params.stateJson) as FirewallStatePayload | null;
  const rules = parseJsonPayload(params.rulesJson);
  if (!state) {
    return null;
  }
  const rulePayload =
    rules && typeof rules === "object" && !Array.isArray(rules)
      ? (rules as { ActiveRules?: unknown; LocalRules?: unknown })
      : null;
  return {
    activeProfileNames: parseConnectionProfileNames(state.ConnectionProfiles),
    activeProfiles: parseFirewallProfiles(state.ActiveFirewallProfiles),
    localProfiles: parseFirewallProfiles(state.LocalFirewallProfiles),
    matchingRules: parseFirewallRules(rulePayload ? rulePayload.ActiveRules : rules),
    localMatchingRules: parseFirewallRules(rulePayload?.LocalRules),
    netshOutput: params.netshOutput ?? "",
  };
}

export async function inspectWindowsGatewayFirewall(
  params: InspectWindowsGatewayFirewallParams,
): Promise<WindowsGatewayFirewallDiagnostic> {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32" || params.bind !== "lan") {
    return {
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    };
  }

  const runCommandWithTimeout = params.runCommandWithTimeout ?? defaultRunCommandWithTimeout;
  const mode = params.mode ?? "full";
  const timeoutMs =
    params.timeoutMs ??
    (mode === "quick"
      ? QUICK_WINDOWS_GATEWAY_FIREWALL_TIMEOUT_MS
      : DEFAULT_WINDOWS_GATEWAY_FIREWALL_TIMEOUT_MS);
  if (mode === "quick") {
    const quickJson = await runBestEffortCommand(
      runCommandWithTimeout,
      powershell(buildWindowsQuickFirewallCommand(params.port)),
      timeoutMs,
    );
    if (quickJson === null) {
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_inspection_failed",
        message: "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
        details: [
          "Run `openclaw gateway status --deep` again, or verify the advertised LAN URL from another device.",
        ],
      };
    }
    const quickPayload = parseJsonPayload(quickJson) as QuickFirewallPayload | null;
    if (!quickPayload || typeof quickPayload !== "object" || Array.isArray(quickPayload)) {
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_inspection_failed",
        message: "OpenClaw could not parse Windows Firewall LAN Gateway policy.",
        details: [
          "Run `openclaw gateway status --deep` again, or verify the advertised LAN URL from another device.",
        ],
      };
    }
    const managedActiveRules = parseFirewallRules(quickPayload.ActiveRules);
    const localRules = parseFirewallRules(quickPayload.LocalRules);
    const stateJson = JSON.stringify(quickPayload.State ?? null);
    const policyState = parseWindowsGatewayFirewallState({
      stateJson,
      rulesJson: JSON.stringify({
        ActiveRules: [],
        LocalRules: [],
      }),
    });
    if (!policyState) {
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_inspection_failed",
        message: "OpenClaw could not parse Windows Firewall LAN Gateway policy.",
        details: [
          "Run `openclaw gateway status --deep` again, or verify the advertised LAN URL from another device.",
        ],
      };
    }
    const activeRules = [
      ...managedActiveRules,
      ...(localRulesAreAllowed(policyState) ? localRules : []),
    ];
    const state = buildClassifiedState(stateJson, "", activeRules, localRules);
    return state
      ? classifyWindowsGatewayFirewallState(state)
      : {
          applies: true,
          severity: "warning",
          code: "windows_firewall_inspection_failed",
          message: "OpenClaw could not parse Windows Firewall LAN Gateway policy.",
          details: [
            "Run `openclaw gateway status --deep` again, or verify the advertised LAN URL from another device.",
          ],
        };
  }
  const [stateJson, rulesJson, netshOutput] = await Promise.all([
    runBestEffortCommand(
      runCommandWithTimeout,
      powershell(WINDOWS_FIREWALL_STATE_COMMAND),
      timeoutMs,
    ),
    runBestEffortCommand(
      runCommandWithTimeout,
      powershell(buildWindowsFirewallRulesCommand(params.port)),
      timeoutMs,
    ),
    runBestEffortCommand(
      runCommandWithTimeout,
      [getWindowsSystem32ExePath("netsh.exe"), "advfirewall", "show", "allprofiles"],
      timeoutMs,
    ),
  ]);

  if (stateJson === null || rulesJson === null) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_inspection_failed",
      message: "OpenClaw could not inspect Windows Firewall policy for LAN Gateway reachability.",
      details: [
        "Run `openclaw gateway status --deep` from a normal PowerShell session and verify the advertised LAN URL from another device.",
      ],
    };
  }
  const firewallPolicyText = netshOutput ?? "";
  const localRules = parseFirewallRules(parseJsonPayload(rulesJson));
  const policyState = parseWindowsGatewayFirewallState({
    stateJson,
    rulesJson: JSON.stringify({
      ActiveRules: [],
      LocalRules: [],
    }),
    netshOutput: firewallPolicyText,
  });
  if (!policyState) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_inspection_failed",
      message: "OpenClaw could not parse Windows Firewall policy for LAN Gateway reachability.",
      details: [
        "Run `openclaw gateway status --deep` from a normal PowerShell session and verify the advertised LAN URL from another device.",
      ],
    };
  }
  let activeRules = localRulesAreAllowed(policyState) ? localRules : [];
  let state = buildClassifiedState(stateJson, firewallPolicyText, activeRules, localRules);
  if (!state) {
    return {
      applies: true,
      severity: "warning",
      code: "windows_firewall_inspection_failed",
      message: "OpenClaw could not parse Windows Firewall policy for LAN Gateway reachability.",
      details: [
        "Run `openclaw gateway status --deep` from a normal PowerShell session and verify the advertised LAN URL from another device.",
      ],
    };
  }

  const initialDiagnostic = classifyWindowsGatewayFirewallState(state);
  if (shouldProbeManagedActiveRules(initialDiagnostic)) {
    const managedRulesJson = await runBestEffortCommand(
      runCommandWithTimeout,
      powershell(buildWindowsManagedActiveFirewallRulesCommand(params.port)),
      timeoutMs,
    );
    if (managedRulesJson !== null) {
      activeRules = [...activeRules, ...parseFirewallRules(parseJsonPayload(managedRulesJson))];
      state = buildClassifiedState(stateJson, firewallPolicyText, activeRules, localRules);
      if (!state) {
        return {
          applies: true,
          severity: "warning",
          code: "windows_firewall_inspection_failed",
          message: "OpenClaw could not parse Windows Firewall policy for LAN Gateway reachability.",
          details: [
            "Run `openclaw gateway status --deep` from a normal PowerShell session and verify the advertised LAN URL from another device.",
          ],
        };
      }
    } else if (!localRulesAreAllowed(state)) {
      return {
        applies: true,
        severity: "warning",
        code: "windows_firewall_inspection_failed",
        message:
          "OpenClaw could not inspect managed Windows Firewall rules for LAN Gateway reachability.",
        details: [
          "Run `openclaw gateway status --deep` from a normal PowerShell session and verify Group Policy or administrator-managed allow rules for the Gateway port.",
        ],
      };
    }
  }

  const diagnosticBeforeLocalDetail = classifyWindowsGatewayFirewallState(state);
  if (!localRulesAreAllowed(state) && diagnosticBeforeLocalDetail.severity !== "info") {
    const localRulesJson = await runBestEffortCommand(
      runCommandWithTimeout,
      powershell(buildWindowsPersistentFirewallRulesCommand(params.port)),
      Math.max(timeoutMs, 10_000),
    );
    if (localRulesJson !== null) {
      state.localMatchingRules = parseFirewallRules(parseJsonPayload(localRulesJson));
    }
  }

  return classifyWindowsGatewayFirewallState(state);
}

export function formatWindowsGatewayFirewallGuidance(params: {
  bind: string | undefined;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32" || params.bind !== "lan") {
    return [];
  }
  return [
    "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
  ];
}
