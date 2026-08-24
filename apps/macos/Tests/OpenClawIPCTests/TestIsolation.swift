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
        func restoreUserDefaults(_ values: [String: Any?], userDefaults: UserDefaults) {
            for (key, value) in values {
                if let value {
                    userDefaults.set(value, forKey: key)
                } else {
                    userDefaults.removeObject(forKey: key)
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
        var previousEnv: [String: String?] = [:]
        for (key, value) in env {
            previousEnv[key] = getenv(key).map { String(cString: $0) }
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        let userDefaults = AppDefaults.standard
        var previousDefaults: [String: Any?] = [:]
        for (key, value) in defaults {
            previousDefaults[key] = userDefaults.object(forKey: key)
            if let value {
                userDefaults.set(value, forKey: key)
            } else {
                userDefaults.removeObject(forKey: key)
            }
        }

        do {
            let result = try await body()
            restoreUserDefaults(previousDefaults, userDefaults: userDefaults)
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            return result
        } catch {
            restoreUserDefaults(previousDefaults, userDefaults: userDefaults)
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
