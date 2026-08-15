import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct NixModeStableSuiteTests {
    @Test func `does not create a stable suite for the app's own bundle identifier`() {
        #expect(ProcessInfo.resolveStableNixSuite(bundleIdentifier: launchdLabel, isAppBundle: true) == nil)
    }

    @Test func `creates a stable suite for renamed app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuite(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: true) != nil)
    }

    @Test func `does not create a stable suite outside app bundles`() {
        #expect(ProcessInfo.resolveStableNixSuite(
            bundleIdentifier: "ai.openclaw.mac.renamed",
            isAppBundle: false) == nil)
    }

    @Test func `resolves from stable suite for app bundles`() throws {
        let suite = try #require(UserDefaults(suiteName: launchdLabel))
        let key = "openclaw.nixMode"
        let prev = suite.object(forKey: key)
        defer {
            if let prev {
                suite.set(prev, forKey: key)
            } else {
                suite.removeObject(forKey: key)
            }
        }

        suite.set(true, forKey: key)

        let standard = try #require(UserDefaults(suiteName: "NixModeStableSuiteTests.\(UUID().uuidString)"))
        #expect(!standard.bool(forKey: key))

        let resolved = ProcessInfo.resolveNixMode(
            environment: [:],
            standard: standard,
            stableSuite: suite,
            isAppBundle: true)
        #expect(resolved)
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

    @Test func `ignores stable suite outside app bundles`() throws {
        let suite = try #require(UserDefaults(suiteName: launchdLabel))
        let key = "openclaw.nixMode"
        let prev = suite.object(forKey: key)
        defer {
            if let prev {
                suite.set(prev, forKey: key)
            } else {
                suite.removeObject(forKey: key)
            }
        }

        suite.set(true, forKey: key)
        let standard = try #require(UserDefaults(suiteName: "NixModeStableSuiteTests.\(UUID().uuidString)"))

        let resolved = ProcessInfo.resolveNixMode(
            environment: [:],
            standard: standard,
            stableSuite: suite,
            isAppBundle: false)
        #expect(!resolved)
    }
}
