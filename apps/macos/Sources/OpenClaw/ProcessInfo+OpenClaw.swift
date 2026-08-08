import Foundation

extension ProcessInfo {
    /// SwiftPM loads test bundles into these helpers, so bundle inspection alone
    /// cannot identify every test process. Keep current and legacy runner names.
    private static let swiftPMTestHelperNames: Set<String> = [
        "swiftpm-testing-helper",
        "swiftpm-xctest-helper",
    ]

    var isPreview: Bool {
        guard let raw = getenv("XCODE_RUNNING_FOR_PREVIEWS") else { return false }
        return String(cString: raw) == "1"
    }

    static func resolveStableNixSuite(bundleIdentifier: String?, isAppBundle: Bool) -> UserDefaults? {
        // The app's own defaults domain is already represented by UserDefaults.standard.
        // Passing that same identifier to suiteName triggers Foundation's nonsensical-suite warning.
        guard isAppBundle, bundleIdentifier != launchdLabel else { return nil }
        return UserDefaults(suiteName: launchdLabel)
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
        let stableSuite = Self.resolveStableNixSuite(
            bundleIdentifier: Bundle.main.bundleIdentifier,
            isAppBundle: isAppBundle)
        return Self.resolveNixMode(
            environment: self.environment,
            standard: .standard,
            stableSuite: stableSuite,
            isAppBundle: isAppBundle)
    }

    static func resolveIsRunningTests(
        environment: [String: String],
        processName: String,
        arguments: [String],
        bundleURLs: [URL]) -> Bool
    {
        if bundleURLs.contains(where: { $0.pathExtension == "xctest" }) { return true }
        if self.swiftPMTestHelperNames.contains(processName) { return true }
        if let executable = arguments.first.map({ URL(fileURLWithPath: $0).lastPathComponent }),
           self.swiftPMTestHelperNames.contains(executable)
        {
            return true
        }
        return environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
            || environment["XCTestSessionIdentifier"] != nil
    }

    var isRunningTests: Bool {
        Self.resolveIsRunningTests(
            environment: self.environment,
            processName: self.processName,
            arguments: self.arguments,
            bundleURLs: Bundle.allBundles.map(\.bundleURL) + [Bundle.main.bundleURL])
    }
}
