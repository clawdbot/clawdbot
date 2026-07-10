import Foundation

extension ProcessInfo {
    var isPreview: Bool {
        guard let raw = getenv("XCODE_RUNNING_FOR_PREVIEWS") else { return false }
        return String(cString: raw) == "1"
    }

    /// Nix deployments may write defaults into a stable suite (`ai.openclaw.mac`) even if the shipped
    /// app bundle identifier changes (and therefore `UserDefaults.standard` domain changes).
    static func resolveNixMode(
        environment: [String: String],
        standard: UserDefaults,
        stableSuite: UserDefaults?,
        isAppBundle: Bool) -> Bool
    {
        if environment["OPENCLAW_NIX_MODE"] == "1" { return true }
        if standard.bool(forKey: "openclaw.nixMode") { return true }

        // Only consult the stable suite when running as a .app bundle.
        // This avoids local developer machines accidentally influencing unit tests.
        if isAppBundle, let stableSuite, stableSuite.bool(forKey: "openclaw.nixMode") { return true }

        return false
    }

    var isNixMode: Bool {
        let isAppBundle = Bundle.main.bundleURL.pathExtension == "app"
        let stableSuite = UserDefaults(suiteName: launchdLabel)
        return Self.resolveNixMode(
            environment: self.environment,
            standard: .standard,
            stableSuite: stableSuite,
            isAppBundle: isAppBundle)
    }

    var isRunningTests: Bool {
        // SwiftPM tests load one or more `.xctest` bundles. With Swift Testing, `Bundle.main` is not
        // guaranteed to be the `.xctest` bundle, so check all loaded bundles.
        if Bundle.allBundles.contains(where: { $0.bundleURL.pathExtension == "xctest" }) { return true }
        if Bundle.main.bundleURL.pathExtension == "xctest" { return true }

        // Backwards-compatible fallbacks for runners that still set XCTest env vars.
        return self.environment["XCTestConfigurationFilePath"] != nil
            || self.environment["XCTestBundlePath"] != nil
            || self.environment["XCTestSessionIdentifier"] != nil
    }
}
