import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct NixModeStableSuiteTests {
    @Test func `does not select a stable suite for the app's own bundle identifier`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(bundleIdentifier: launchdLabel, isAppBundle: true) == nil)
    }

    @Test func `selects the stable suite for renamed app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: true) == launchdLabel)
    }

    @Test func `does not select a stable suite outside app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuiteName(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: false) == nil)
    }

    @Test func `resolves Nix mode from independent defaults domains and environment`() throws {
        let standardName = "NixModeStableSuiteTests.standard.\(UUID().uuidString)"
        let standard = try #require(UserDefaults(suiteName: standardName))
        defer { standard.removePersistentDomain(forName: standardName) }
        let stableName = "NixModeStableSuiteTests.stable.\(UUID().uuidString)"
        let stable = try #require(UserDefaults(suiteName: stableName))
        defer { stable.removePersistentDomain(forName: stableName) }
        let key = "openclaw.nixMode"
        let cases: [(environment: String?, standard: Bool, stable: Bool?, isApp: Bool, expected: Bool)] = [
            (nil, false, nil, true, false),
            (nil, false, false, true, false),
            (nil, false, true, true, true),
            (nil, false, true, false, false),
            (nil, true, false, true, true),
            (nil, true, true, false, true),
            ("1", false, false, true, true),
            ("1", false, nil, false, true),
            ("0", false, false, true, false),
            ("0", true, false, false, true),
            ("0", false, true, true, true),
            ("true", false, false, true, false),
        ]
        for input in cases {
            standard.set(input.standard, forKey: key)
            stable.set(input.stable ?? false, forKey: key)
            #expect(ProcessInfo.resolveNixMode(
                environment: input.environment.map { ["OPENCLAW_NIX_MODE": $0] } ?? [:],
                standard: standard,
                stableSuite: input.stable == nil ? nil : stable,
                isAppBundle: input.isApp) == input.expected, "\(input)")
        }
    }

    @Test func `detects SwiftPM and XCTest runners`() {
        #expect(ProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "swiftpm-testing-helper",
            arguments: [],
            bundleURLs: []))
        #expect(ProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "swiftpm-xctest-helper",
            arguments: [],
            bundleURLs: []))
        for helper in ["swiftpm-testing-helper", "swiftpm-xctest-helper"] {
            #expect(ProcessInfo.resolveIsRunningTests(
                environment: [:],
                processName: "OpenClawTests",
                arguments: ["/Library/Developer/Toolchains/usr/libexec/swift/pm/\(helper)"],
                bundleURLs: []))
        }
        #expect(ProcessInfo.resolveIsRunningTests(
            environment: ["XCTestSessionIdentifier": "session"],
            processName: "OpenClawTests",
            arguments: [],
            bundleURLs: []))
        #expect(ProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "OpenClawTests",
            arguments: [],
            bundleURLs: [URL(fileURLWithPath: "/tmp/OpenClawTests.xctest")]))
        #expect(!ProcessInfo.resolveIsRunningTests(
            environment: [:],
            processName: "OpenClaw",
            arguments: [],
            bundleURLs: []))
    }
}
