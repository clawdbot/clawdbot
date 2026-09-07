import Darwin
import Foundation
import OpenClawIPC
import OSLog

/// A nonce is consumed before dispatch, so a signed mutation cannot be replayed within its TTL.
actor MacControlRequestAuthenticator {
    private var nonces: [String: Date] = [:]

    func authenticate(
        _ envelope: MacControlEnvelope,
        token: String,
        peerUID: uid_t,
        ownerUID: uid_t,
        now: Date = Date()) throws -> MacControlRequest
    {
        guard peerUID == ownerUID, envelope.authenticated(token: token, now: now) else {
            throw MacControlError(code: "authentication_failed", message: "App control authentication failed.")
        }
        self.nonces = self.nonces.filter { $0.value >= now }
        guard self.nonces[envelope.nonce] == nil else {
            throw MacControlError(code: "authentication_failed", message: "App control request was already used.")
        }
        guard self.nonces.count < 1024 else {
            throw MacControlError(code: "busy", message: "Too many app control requests; try again shortly.")
        }
        let request = try JSONDecoder().decode(MacControlRequest.self, from: Data(envelope.requestJson.utf8))
        self.nonces[envelope.nonce] = Date(timeIntervalSince1970: Double(envelope.ts) / 1000 + 15)
        return request
    }
}

@MainActor
final class MacControlServer {
    static let shared = MacControlServer()
    private nonisolated static let logger = Logger(subsystem: "ai.openclaw", category: "mac-control")

    private var listener: LocalSocketServer?
    private var startup: Task<Void, Never>?
    private var cleanup: Task<Void, Never>?
    private var generation: UInt64 = 0

    func start() {
        guard self.listener == nil, self.startup == nil,
              AppProfile.current.validationError == nil else { return }
        self.generation &+= 1
        let generation = self.generation
        let directory = AppProfile.current.stateDirectoryURL()
        let tokenURL = directory.appendingPathComponent(MacControlCredentials.tokenFilename)
        let listener = LocalSocketServer(
            socketPath: directory.appendingPathComponent(MacControlCredentials.socketFilename).path,
            logger: Self.logger)
        let handler = MacControlRequestHandler(owner: MacControlLiveOwner())
        let authenticator = MacControlRequestAuthenticator()
        let previousCleanup = self.cleanup
        self.listener = listener
        self.startup = Task { [weak self] in
            await previousCleanup?.value
            guard !Task.isCancelled else { return }
            let ready = await withTaskCancellationHandler {
                await listener.start(
                    prepare: { _ = try MacControlCredentials.createIfMissing(at: tokenURL) },
                    handler: { handle in
                        await Self.handleClient(
                            handle, tokenURL: tokenURL, authenticator: authenticator, handler: handler)
                    },
                    onUnexpectedStop: {
                        Self.logger.error("App control listener stopped unexpectedly; restart the app to restore it.")
                    })
            } onCancel: {
                listener.stop()
            }
            guard let self, self.generation == generation, !Task.isCancelled else {
                await listener.stop().value
                return
            }
            self.startup = nil
            if !ready {
                Self.logger
                    .error("App control listener could not start; check the profile socket and credential permissions.")
                self.cleanup = listener.stop()
                self.listener = nil
            }
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never>? {
        self.generation &+= 1
        let startup = self.startup
        startup?.cancel()
        let shutdown = self.listener?.stop()
        self.startup = nil
        self.listener = nil
        guard startup != nil || shutdown != nil else { return self.cleanup }
        let previous = self.cleanup
        let cleanup = Task {
            await previous?.value
            await startup?.value
            await shutdown?.value
        }
        self.cleanup = cleanup
        return cleanup
    }

    private nonisolated static func handleClient(
        _ handle: FileHandle,
        tokenURL: URL,
        authenticator: MacControlRequestAuthenticator,
        handler: MacControlRequestHandler) async
    {
        do {
            try Task.checkCancellation()
            let fd = handle.fileDescriptor
            var uid = uid_t(0)
            var gid = gid_t(0)
            guard getpeereid(fd, &uid, &gid) == 0, uid == geteuid() else {
                throw MacControlError(code: "authentication_failed", message: "App control requires the app's user.")
            }
            try configureSocketTimeouts(fd, timeoutMs: 15000)
            guard let line = try readLineFromSocket(fd, maxBytes: MacControlCredentials.maximumFrameBytes) else {
                return
            }
            let envelope = try JSONDecoder().decode(MacControlEnvelope.self, from: Data(line.utf8))
            // Read on every request: a missing or replaced credential never falls back to a cached token.
            let token = try MacControlCredentials.read(at: tokenURL)
            let request = try await authenticator.authenticate(
                envelope, token: token, peerUID: uid, ownerUID: geteuid())
            try Task.checkCancellation()
            let response = await handler.handle(request)
            try Task.checkCancellation()
            try self.send(response, to: handle)
        } catch {
            guard !Task.isCancelled else { return }
            let failure = error as? MacControlError ?? MacControlError(
                code: "invalid_request", message: "Could not read a valid app control request.")
            if let data = try? JSONEncoder().encode(MacControlResponse<Bool>(error: failure)) {
                try? self.send(data, to: handle)
            }
        }
    }

    private nonisolated static func send(_ data: Data, to handle: FileHandle) throws {
        guard data.count < MacControlCredentials.maximumFrameBytes else {
            throw MacControlError(
                code: "response_too_large",
                message: "The app control result exceeds the response limit.")
        }
        var frame = data
        frame.append(0x0A)
        try handle.write(contentsOf: frame)
    }
}
