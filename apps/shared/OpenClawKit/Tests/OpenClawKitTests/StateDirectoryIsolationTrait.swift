import Foundation
import Testing

private actor StateDirectoryTestGate {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !self.locked {
            self.locked = true
            return
        }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func release() {
        guard !self.waiters.isEmpty else {
            self.locked = false
            return
        }
        self.waiters.removeFirst().resume()
    }
}

/// Serializes state-directory tests and pins `OPENCLAW_STATE_DIR` to a fresh
/// per-test temp dir. Device identity/auth stores resolve that env var on every
/// call; without the pin they fall back to the developer's real store
/// (app group container or ~/Library/Application Support/OpenClaw), so real
/// device tokens leak into nil-token assertions on machines that ran the app.
/// Tests needing a custom dir (for example an unwritable path) may still set
/// the env var themselves and restore the previous value.
struct StateDirectoryIsolationTrait: TestTrait, TestScoping {
    private static let gate = StateDirectoryTestGate()

    /// Value restored between gated tests: the operator-provided launch value
    /// when present, else a run-scoped quarantine dir. Never restore to unset —
    /// leaked background tasks (reconnect watchdogs from failed tests) would
    /// then write fake tokens into the developer's real store.
    private static let restoreStateDirPath: String = {
        if let raw = getenv("OPENCLAW_STATE_DIR") {
            let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return value
            }
        }
        let quarantine = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-test-state-quarantine-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: quarantine, withIntermediateDirectories: true)
        return quarantine.path
    }()

    func provideScope(
        for test: Test,
        testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void) async throws
    {
        await Self.gate.acquire()
        // Resolve the restore value before the first setenv so it captures the
        // launch environment, not a prior test's temp dir.
        let restorePath = Self.restoreStateDirPath
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-test-state-\(UUID().uuidString)", isDirectory: true)
        var thrown: (any Error)?
        do {
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
            setenv("OPENCLAW_STATE_DIR", stateDir.path, 1)
            try await function()
        } catch {
            thrown = error
        }
        // Restore env before releasing the gate; the next gated test sets its
        // own dir immediately after acquire and must not be clobbered.
        setenv("OPENCLAW_STATE_DIR", restorePath, 1)
        try? FileManager.default.removeItem(at: stateDir)
        await Self.gate.release()
        if let thrown {
            throw thrown
        }
    }
}

extension Trait where Self == StateDirectoryIsolationTrait {
    static var stateDirectoryIsolated: Self {
        Self()
    }
}
