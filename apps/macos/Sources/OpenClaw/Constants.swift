import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-openclaw writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.openclaw.mac"
var gatewayLaunchdLabel: String {
    AppProfile.current.gatewayLaunchAgentLabel
}

let nodeLaunchdLabel = "ai.openclaw.node"
let onboardingVersionKey = "openclaw.onboardingVersion"
let onboardingSeenKey = "openclaw.onboardingSeen"
let onboardingSystemAgentPendingKey = "openclaw.onboardingSystemAgentPending"
// Pre-rename releases persisted pending activations under the Crestodian key.
let onboardingSystemAgentPendingRetiredKey = "openclaw.onboardingCrestodianPending"
let currentOnboardingVersion = 8
let pauseDefaultsKey = "openclaw.pauseEnabled"
let iconAnimationsEnabledKey = "openclaw.iconAnimationsEnabled"
let swabbleEnabledKey = "openclaw.swabbleEnabled"
let swabbleTriggersKey = "openclaw.swabbleTriggers"
let voiceWakeTriggerChimeKey = "openclaw.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "openclaw.voiceWakeSendChime"
let showDockIconKey = "openclaw.showDockIcon"
let defaultVoiceWakeTriggers = ["openclaw"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "openclaw.voiceWakeMicID"
let voiceWakeMicNameKey = "openclaw.voiceWakeMicName"
let voiceWakeLocaleKey = "openclaw.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "openclaw.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "openclaw.voicePushToTalkEnabled"
let voiceWakeTriggersTalkModeKey = "openclaw.voiceWakeTriggersTalkMode"
let talkEnabledKey = "openclaw.talkEnabled"
let talkRealtimeRelayEnabledKey = "openclaw.talkRealtimeRelayEnabled"
let talkPhaseSoundsEnabledKey = "openclaw.talkPhaseSoundsEnabled"
let talkShiftToStopEnabledKey = "openclaw.talkShiftToStopEnabled"
let iconOverrideKey = "openclaw.iconOverride"
let connectionModeKey = "openclaw.connectionMode"
let remoteTargetKey = "openclaw.remoteTarget"
let remoteIdentityKey = "openclaw.remoteIdentity"
let remoteProjectRootKey = "openclaw.remoteProjectRoot"
let remoteCliPathKey = "openclaw.remoteCliPath"
let canvasEnabledKey = "openclaw.canvasEnabled"
let quickChatEnabledKey = "openclaw.quickChatEnabled"
let cameraEnabledKey = "openclaw.cameraEnabled"
let computerControlEnabledKey = "openclaw.computerControlEnabled"
let computerControlProviderKey = "openclaw.computerControlProvider"
let cookieSyncEnabledKey = "openclaw.cookieSyncEnabled"
let cookieSyncIntoProfileKey = "openclaw.cookieSyncIntoProfile"
let cookieSyncDomainsKey = "openclaw.cookieSyncDomains"

func isTalkRealtimeRelayEnabled(defaults: UserDefaults = AppDefaults.standard) -> Bool {
    defaults.object(forKey: talkRealtimeRelayEnabledKey) as? Bool ?? false
}

func isComputerControlEnabled(
    defaults: UserDefaults = AppDefaults.standard,
    launchPlan: AppLaunchRuntimePlan = .current) -> Bool
{
    // object(forKey:) preserves an explicit false; bool(forKey:) would conflate it with an unset default.
    let storedValue = defaults.object(forKey: computerControlEnabledKey) as? Bool ?? true
    return launchPlan.resolveComputerControlEnabled(storedValue)
}

let activeComputerPresenceEnabledKey = "openclaw.activeComputerPresenceEnabled"
let locationModeKey = "openclaw.locationMode"
let locationPreciseKey = "openclaw.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "openclaw.peekabooBridgeEnabled"
let deepLinkKeyKey = "openclaw.deepLinkKey"
let cliInstallPromptedVersionKey = "openclaw.cliInstallPromptedVersion"
let cliInstallPolicyKey = "openclaw.cliInstallPolicy"
let cliManagedRestartPendingKey = "openclaw.cliManagedRestartPending"
let postAppUpdateReceiptKey = "openclaw.postAppUpdateReceipt"
let lastLaunchedAppVersionKey = "openclaw.lastLaunchedAppVersion"
let cliValidatedExecutableKey = "openclaw.cliValidatedExecutable"
let cliValidatedVersionKey = "openclaw.cliValidatedVersion"
let macNodeIdentityProfileKey = "openclaw.macNodeIdentityProfile"
let heartbeatsEnabledKey = "openclaw.heartbeatsEnabled"
let debugPaneEnabledKey = "openclaw.debugPaneEnabled"
let nativeSettingsPanesEnabledKey = "openclaw.nativeSettingsPanesEnabled"
let debugFileLogEnabledKey = "openclaw.debug.fileLogEnabled"
let appLogLevelKey = "openclaw.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
