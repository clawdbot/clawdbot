import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

actor TestIsolationLock {
    static let shared = TestIsolationLock()

    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !self.locked {
            self.locked = true
            return
        }
        await withCheckedContinuation { cont in
            self.waiters.append(cont)
        }
        // `unlock()` resumed us; lock is now held for this caller.
    }

    func release() {
        if self.waiters.isEmpty {
            self.locked = false
            return
        }
        let next = self.waiters.removeFirst()
        next.resume()
    }
}

@MainActor
enum TestIsolation {
    static func withIsolatedState<T>(
        env: [String: String?] = [:],
        defaults: [String: Any?] = [:],
        _ body: () async throws -> T) async rethrows -> T
    {
        precondition(!env.keys.contains("OPENCLAW_PROFILE"), "Select the app profile before launching the test process")

        func restoreUserDefaults(_ values: [String: Any?]) {
            for (key, value) in values {
                if let value {
                    AppDefaults.standard.set(value, forKey: key)
                } else {
                    AppDefaults.standard.removeObject(forKey: key)
                }
            }
        }

        func restoreEnv(_ values: [String: String?]) {
            for (key, value) in values {
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        await TestIsolationLock.shared.acquire()
        var env = env
        // Config reads and writes also persist health/audit state. A config-only
        // fixture must not send those writes to the process-wide state directory.
        let ownedStateDirectory: URL? = if let configPath = env["OPENCLAW_CONFIG_PATH"] ?? nil,
                                           !configPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                           !env.keys.contains("OPENCLAW_STATE_DIR")
        {
            FileManager().temporaryDirectory
                .appendingPathComponent("openclaw-config-state-\(UUID().uuidString)", isDirectory: true)
        } else {
            nil
        }
        if let ownedStateDirectory {
            env["OPENCLAW_STATE_DIR"] = ownedStateDirectory.path
        }
        defer {
            if let ownedStateDirectory {
                try? FileManager().removeItem(at: ownedStateDirectory)
            }
        }
        var previousEnv: [String: String?] = [:]
        for (key, value) in env {
            // Absence is captured state: subscript assignment lets map infer String??,
            // dropping absent keys instead of preserving them for restoration.
            previousEnv.updateValue(getenv(key).map { String(cString: $0) }, forKey: key)
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        var previousDefaults: [String: Any?] = [:]
        for (key, value) in defaults {
            previousDefaults.updateValue(AppDefaults.standard.object(forKey: key), forKey: key)
            if let value {
                AppDefaults.standard.set(value, forKey: key)
            } else {
                AppDefaults.standard.removeObject(forKey: key)
            }
        }

        do {
            let result = try await body()
            restoreUserDefaults(previousDefaults)
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            return result
        } catch {
            restoreUserDefaults(previousDefaults)
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    static func withEnvValues<T>(
        _ values: [String: String?],
        _ body: () async throws -> T) async rethrows -> T
    {
        try await self.withIsolatedState(env: values, defaults: [:], body)
    }

    static func withUserDefaultsValues<T>(
        _ values: [String: Any?],
        _ body: () async throws -> T) async rethrows -> T
    {
        try await self.withIsolatedState(env: [:], defaults: values, body)
    }

    nonisolated static func tempConfigPath() -> String {
        FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-test-config-\(UUID().uuidString).json")
            .path
    }
}

struct ExecApprovalsStateIsolationTrait: TestTrait, TestScoping {
    func provideScope(
        for test: Test,
        testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void) async throws
    {
        let stateDirectory = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-approvals-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: stateDirectory) }
        try await ExecApprovalsStore.withStateDirectory(stateDirectory, operation: function)
    }
}

extension Trait where Self == ExecApprovalsStateIsolationTrait {
    static var execApprovalsStateIsolated: Self {
        Self()
    }
}
