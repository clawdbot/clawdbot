import Foundation
import OpenClawKit

/// Shared device and platform info for Settings, gateway node payloads, and device status.
enum DeviceInfoHelper {
    /// Gateway platform metadata, including compatibility-app handling on Apple Silicon Macs.
    @MainActor
    static func platformString() -> String {
        InstanceIdentity.platformString
    }

    /// Always "iOS X.Y.Z" for UI display (e.g. Settings), matching legacy behavior on iPad.
    static func platformStringForDisplay() -> String {
        "iOS \(self.iOSVersionStringForDisplay())"
    }

    /// Version-only display string for About, e.g. "18.0.0".
    static func iOSVersionStringForDisplay() -> String {
        self.iOSVersionStringForDisplay(ProcessInfo.processInfo.operatingSystemVersion)
    }

    static func iOSVersionStringForDisplay(_ version: OperatingSystemVersion) -> String {
        "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// Device family for gateway payloads: "iPad", "iPhone", or "iOS".
    @MainActor
    static func deviceFamily() -> String {
        InstanceIdentity.deviceFamily
    }

    /// Machine model identifier, or a compatibility-host description when running on a Mac.
    static func modelIdentifier() -> String {
        InstanceIdentity.modelIdentifier ?? "unknown"
    }

    /// Canonical app version when present, otherwise the Apple marketing version.
    static func appVersion() -> String {
        (Bundle.main.infoDictionary?["OpenClawCanonicalVersion"] as? String)
            ?? (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
            ?? "dev"
    }

    /// App build string, e.g. "123" or "".
    static func appBuild() -> String {
        let raw = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Display string for Settings: "1.2.3" or "1.2.3 (456)" when build differs.
    static func openClawVersionString() -> String {
        let version = self.appVersion()
        let build = self.appBuild()
        if build.isEmpty || build == version {
            return version
        }
        return "\(version) (\(build))"
    }

    static func buildMetadata() -> ArtifactBuildInfo {
        self.buildMetadata(infoDictionary: Bundle.main.infoDictionary ?? [:])
    }

    static func buildMetadata(infoDictionary: [String: Any]) -> ArtifactBuildInfo {
        ArtifactBuildInfo(
            infoDictionary: infoDictionary,
            versionKeys: ["OpenClawCanonicalVersion", "CFBundleShortVersionString"])
    }
}
