import Darwin
import Foundation
import os
import PeekabooBridge

protocol PeekabooBridgeRuntimeControlling: Sendable {
    func startChecked() async throws -> PeekabooEmbeddedBridgeRuntimeSnapshot
    func stopChecked() async
    func snapshot() async -> PeekabooEmbeddedBridgeRuntimeSnapshot
}

extension PeekabooEmbeddedBridgeRuntime: PeekabooBridgeRuntimeControlling {}

struct LegacyPeekabooSocketAliasManager {
    let targetSocketPath: String
    let aliasSocketPaths: [String]

    func ensureAliases(logger: Logger) {
        for aliasPath in self.aliasSocketPaths {
            self.ensureAlias(at: aliasPath, logger: logger)
        }
    }

    private func ensureAlias(at aliasPath: String, logger: Logger) {
        let fileManager = FileManager.default
        let aliasURL = URL(fileURLWithPath: aliasPath)
        do {
            try fileManager.createDirectory(
                at: aliasURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])

            var pathInfo = Darwin.stat()
            if lstat(aliasPath, &pathInfo) == 0 {
                guard pathInfo.st_mode & S_IFMT == S_IFLNK else {
                    logger.debug(
                        "Preserving non-symlink legacy PeekabooBridge path at \(aliasPath, privacy: .public)")
                    return
                }
                let destination = try fileManager.destinationOfSymbolicLink(atPath: aliasPath)
                let destinationURL = URL(
                    fileURLWithPath: destination,
                    relativeTo: aliasURL.deletingLastPathComponent()).standardizedFileURL
                let targetURL = URL(fileURLWithPath: self.targetSocketPath).standardizedFileURL
                guard destinationURL.path == targetURL.path else {
                    logger.debug(
                        "Preserving unowned legacy PeekabooBridge symlink at \(aliasPath, privacy: .public)")
                    return
                }
                return
            }
            guard errno == ENOENT else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try fileManager.createSymbolicLink(
                atPath: aliasPath,
                withDestinationPath: self.targetSocketPath)
        } catch {
            let message = "Failed to create legacy PeekabooBridge socket symlink: \(error.localizedDescription)"
            logger.debug("\(message, privacy: .public)")
        }
    }
}

@MainActor
final class PeekabooBridgeHostCoordinator {
    typealias RuntimeFactory = @MainActor () -> any PeekabooBridgeRuntimeControlling

    static let shared = PeekabooBridgeHostCoordinator()

    static let allowedClientTeamIDs = PeekabooBridgeConstants.trustedReleaseTeamIDs
    static let allowedClientBundleIDs: Set<String> = ["boo.peekaboo.peekaboo"]

    private static let legacySocketDirectoryNames = ["clawdbot", "clawdis", "moltbot"]

    private let logger: Logger
    private let runtimeFactory: RuntimeFactory
    private let aliasManager: LegacyPeekabooSocketAliasManager

    private var desiredEnabled = false
    private var retainedRuntime: (any PeekabooBridgeRuntimeControlling)?
    private var reconciliationTail: Task<Void, Never>?

    init() {
        let socketPath = Self.openclawSocketPath
        self.logger = Logger(subsystem: "ai.openclaw", category: "PeekabooBridge")
        self.runtimeFactory = {
            PeekabooEmbeddedBridgeRuntime.make(
                configuration: .init(
                    socketPath: socketPath,
                    allowlistedTeams: Self.allowedClientTeamIDs,
                    allowlistedBundles: Self.allowedClientBundleIDs,
                    hostKind: .gui),
                snapshotOptions: .init(
                    snapshotValidityWindow: 600,
                    maxSnapshots: 50,
                    deleteArtifactsOnCleanup: false,
                    copyArtifactsOnStore: true))
        }
        self.aliasManager = LegacyPeekabooSocketAliasManager(
            targetSocketPath: socketPath,
            aliasSocketPaths: Self.legacySocketPaths)
    }

    init(runtimeFactory: @escaping RuntimeFactory, aliasManager: LegacyPeekabooSocketAliasManager) {
        self.logger = Logger(subsystem: "ai.openclaw", category: "PeekabooBridge")
        self.runtimeFactory = runtimeFactory
        self.aliasManager = aliasManager
    }

    func setEnabled(_ enabled: Bool) async {
        self.desiredEnabled = enabled
        let predecessor = self.reconciliationTail
        let operation = Task { @MainActor [weak self] in
            await predecessor?.value
            await self?.reconcileDesiredState()
        }
        self.reconciliationTail = operation
        await operation.value
    }

    func shutdown() async {
        await self.setEnabled(false)
    }

    private static var openclawSocketPath: String {
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return Self.makeSocketPath(for: "OpenClaw", in: base)
    }

    private static func makeSocketPath(for directoryName: String, in baseDirectory: URL) -> String {
        baseDirectory
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent(PeekabooBridgeConstants.socketName, isDirectory: false)
            .path
    }

    private static var legacySocketPaths: [String] {
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return Self.legacySocketDirectoryNames.map { Self.makeSocketPath(for: $0, in: base) }
    }

    private func reconcileDesiredState() async {
        if self.desiredEnabled {
            await self.ensureStarted()
        } else {
            await self.ensureStopped()
        }
    }

    private func ensureStarted() async {
        if let retainedRuntime {
            let snapshot = await retainedRuntime.snapshot()
            guard snapshot.state != .ready else { return }
            do {
                let started = try await retainedRuntime.startChecked()
                guard started.state == .ready else {
                    self.logger.error("PeekabooBridge retained runtime did not become ready")
                    return
                }
                self.aliasManager.ensureAliases(logger: self.logger)
            } catch {
                let message = "Failed to restart retained PeekabooBridge runtime: \(error.localizedDescription)"
                self.logger.error("\(message, privacy: .public)")
            }
            return
        }

        let candidate = self.runtimeFactory()
        do {
            let started = try await candidate.startChecked()
            guard started.state == .ready else {
                await self.stopCandidate(candidate)
                self.logger.error("PeekabooBridge runtime returned before becoming ready")
                return
            }
            guard self.desiredEnabled else {
                await self.stopCandidate(candidate)
                return
            }

            self.retainedRuntime = candidate
            self.aliasManager.ensureAliases(logger: self.logger)
            self.logger.info("PeekabooBridge host ready at \(started.socketPath, privacy: .public)")
        } catch {
            self.logger.error("Failed to start PeekabooBridge host: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func ensureStopped() async {
        guard let retainedRuntime else { return }
        await retainedRuntime.stopChecked()
        let snapshot = await retainedRuntime.snapshot()
        guard snapshot.state == .stopped else {
            // A runtime that still owns the socket must stay retained so the next reconciliation can finish teardown.
            let state = snapshot.state.rawValue
            self.logger.error("PeekabooBridge host retained after incomplete stop in state \(state, privacy: .public)")
            return
        }
        self.retainedRuntime = nil
        self.logger.info("PeekabooBridge host stopped")
    }

    private func stopCandidate(_ candidate: any PeekabooBridgeRuntimeControlling) async {
        await candidate.stopChecked()
        let snapshot = await candidate.snapshot()
        guard snapshot.state == .stopped else {
            self.retainedRuntime = candidate
            let state = snapshot.state.rawValue
            let message = "PeekabooBridge candidate retained after incomplete stop in state \(state)"
            self.logger.error("\(message, privacy: .public)")
            return
        }
    }
}
