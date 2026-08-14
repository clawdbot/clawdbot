import Foundation
import Testing
@testable import OpenClaw

struct ComputerControlSettingsTests {
    @Test func `computer control defaults on while preserving explicit choices`() throws {
        let suiteName = "ComputerControlSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(isComputerControlEnabled(defaults: defaults))

        defaults.set(false, forKey: computerControlEnabledKey)
        #expect(!isComputerControlEnabled(defaults: defaults))

        defaults.set(true, forKey: computerControlEnabledKey)
        #expect(isComputerControlEnabled(defaults: defaults))
    }

    @Test func `computer control provider defaults to Peekaboo and preserves CUA selection`() throws {
        let suiteName = "ComputerControlProviderSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .cua)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: false) == .peekaboo)
        defaults.set("retired-provider", forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
    }

    @Test func `bundled CUA locator accepts only a regular executable and never follows a symlink`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cua-artifact-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let binary = root.appendingPathComponent(CuaDriverArtifact.resourceName)
        try Data("driver".utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        #expect(CuaDriverArtifact.executableURL(in: root) == binary)

        try FileManager.default.removeItem(at: binary)
        let target = root.appendingPathComponent("real-driver")
        try Data("driver".utf8).write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try FileManager.default.createSymbolicLink(at: binary, withDestinationURL: target)
        #expect(CuaDriverArtifact.executableURL(in: root) == nil)
    }
}
