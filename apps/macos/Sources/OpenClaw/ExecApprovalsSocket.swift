import AppKit
import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import OSLog

struct ExecApprovalPromptRequest: Codable {
    var command: String
    var cwd: String?
    var host: String?
    var security: String?
    var ask: String?
    var agentId: String?
    var resolvedPath: String?
    var sessionKey: String?
    var allowedDecisions: [ExecApprovalDecision]?

    init(
        command: String,
        cwd: String? = nil,
        host: String? = nil,
        security: String? = nil,
        ask: String? = nil,
        agentId: String? = nil,
        resolvedPath: String? = nil,
        sessionKey: String? = nil,
        allowedDecisions: [ExecApprovalDecision]? = nil)
    {
        self.command = command
        self.cwd = cwd
        self.host = host
        self.security = security
        self.ask = ask
        self.agentId = agentId
        self.resolvedPath = resolvedPath
        self.sessionKey = sessionKey
        self.allowedDecisions = allowedDecisions
    }

    private enum CodingKeys: String, CodingKey {
        case command
        case cwd
        case host
        case security
        case ask
        case agentId
        case resolvedPath
        case sessionKey
        case allowedDecisions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.command = try container.decode(String.self, forKey: .command)
        self.cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        self.host = try container.decodeIfPresent(String.self, forKey: .host)
        self.security = try container.decodeIfPresent(String.self, forKey: .security)
        self.ask = try container.decodeIfPresent(String.self, forKey: .ask)
        self.agentId = try container.decodeIfPresent(String.self, forKey: .agentId)
        self.resolvedPath = try container.decodeIfPresent(String.self, forKey: .resolvedPath)
        self.sessionKey = try container.decodeIfPresent(String.self, forKey: .sessionKey)
        let decodedDecisions = (try? container.decodeIfPresent(
            [DecodedExecApprovalDecision].self,
            forKey: .allowedDecisions)) ?? []
        self.allowedDecisions = decodedDecisions.compactMap(\.decision)
    }

    static func allowedDecisions(
        forAsk ask: String?,
        allowAlwaysEligible: Bool = true) -> [ExecApprovalDecision]
    {
        // Older payloads did not carry ask/allowedDecisions. Preserve their durable
        // approval option; explicit ask=always and allowedDecisions payloads are the
        // policy-carrying shapes that remove it.
        guard allowAlwaysEligible else { return [.allowOnce, .deny] }
        return ask == ExecAsk.always.rawValue
            ? [.allowOnce, .deny]
            : [.allowOnce, .allowAlways, .deny]
    }
}

private struct DecodedExecApprovalDecision: Decodable {
    var decision: ExecApprovalDecision?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard let raw = try? container.decode(String.self) else {
            self.decision = nil
            return
        }
        self.decision = ExecApprovalDecision(rawValue: raw)
    }
}

private struct ExecApprovalSocketRequest: Codable {
    var type: String
    var token: String
    var id: String
    var request: ExecApprovalPromptRequest
}

private struct ExecApprovalSocketDecision: Codable {
    var type: String
    var id: String
    var decision: ExecApprovalDecision
}

private struct ExecHostSocketRequest: Codable {
    var type: String
    var id: String
    var nonce: String
    var ts: Int
    var hmac: String
    var requestJson: String
}

struct ExecHostRequest: Codable {
    var command: [String]
    var rawCommand: String?
    var cwd: String?
    var env: [String: String]?
    var timeoutMs: Int?
    var needsScreenRecording: Bool?
    var agentId: String?
    var sessionKey: String?
    var approvalDecision: ExecApprovalDecision?
    var approvalSource: String?
}

private struct ExecHostRunResult: Codable {
    var exitCode: Int?
    var timedOut: Bool
    var success: Bool
    var stdout: String
    var stderr: String
    var error: String?
}

enum ExecHostOutputLimiter {
    static let maxJsonlResponseBytes = 16 * 1024 * 1024
    static let maxOutputFieldBytes = 1024 * 1024
    private static let truncationMarker = "... (truncated) "

    static func truncate(_ value: String) -> String {
        let bytes = value.utf8
        guard bytes.count > self.maxOutputFieldBytes else { return value }

        let tailBudget = self.maxOutputFieldBytes - self.truncationMarker.utf8.count
        var start = bytes.index(bytes.endIndex, offsetBy: -tailBudget)
        while start < bytes.endIndex, (bytes[start] & 0xC0) == 0x80 {
            start = bytes.index(after: start)
        }
        let tail = String(bytes: bytes[start...], encoding: .utf8) ?? ""
        return self.truncationMarker + tail
    }
}

struct ExecHostError: Codable, Error {
    var code: String
    var message: String
    var reason: String?
}

private struct ExecHostResponse: Codable {
    var type: String
    var id: String
    var ok: Bool
    var payload: ExecHostRunResult?
    var error: ExecHostError?
}

private func configureSocketTimeouts(_ fd: Int32, timeoutMs: Int) throws {
    guard timeoutMs > 0 else { return }
    var timeout = timeval(
        tv_sec: timeoutMs / 1000,
        tv_usec: Int32((timeoutMs % 1000) * 1000))
    let timeoutSize = socklen_t(MemoryLayout.size(ofValue: timeout))
    guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, timeoutSize) == 0,
          setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, timeoutSize) == 0
    else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

private func readLineFromSocket(_ fd: Int32, maxBytes: Int) throws -> String? {
    // Foundation can wait for the full requested byte count on sockets. POSIX
    // recv returns short JSONL frames; the socket timeout bounds idle peers.
    var buffer = Data()
    while buffer.count < maxBytes {
        var chunk = [UInt8](repeating: 0, count: min(4096, maxBytes - buffer.count))
        let count = chunk.withUnsafeMutableBytes { bytes in
            recv(fd, bytes.baseAddress, bytes.count, 0)
        }
        if count == 0 {
            break
        }
        if count < 0 {
            if errno == EINTR {
                continue
            }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        buffer.append(contentsOf: chunk.prefix(count))
        if buffer.contains(0x0A) {
            break
        }
    }
    guard let newlineIndex = buffer.firstIndex(of: 0x0A) else {
        guard !buffer.isEmpty else { return nil }
        return String(data: buffer, encoding: .utf8)
    }
    let lineData = buffer.subdata(in: 0..<newlineIndex)
    return String(data: lineData, encoding: .utf8)
}

func timingSafeHexStringEquals(_ lhs: String, _ rhs: String) -> Bool {
    let lhsBytes = Array(lhs.utf8)
    let rhsBytes = Array(rhs.utf8)
    guard lhsBytes.count == rhsBytes.count else {
        return false
    }

    var diff: UInt8 = 0
    for index in lhsBytes.indices {
        diff |= lhsBytes[index] ^ rhsBytes[index]
    }
    return diff == 0
}

func execHostTimestampIsFresh(
    nowMs: Int,
    requestMs: Int,
    toleranceMs: Int = 10000) -> Bool
{
    guard toleranceMs >= 0 else { return false }
    let (lowerBound, lowerOverflow) = nowMs.subtractingReportingOverflow(toleranceMs)
    if !lowerOverflow, requestMs < lowerBound {
        return false
    }
    let (upperBound, upperOverflow) = nowMs.addingReportingOverflow(toleranceMs)
    if !upperOverflow, requestMs > upperBound {
        return false
    }
    return true
}

enum ExecApprovalsSocketClient {
    private struct TimeoutError: LocalizedError {
        var message: String
        var errorDescription: String? {
            self.message
        }
    }

    static func requestDecision(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest,
        timeoutMs: Int = 15000) async -> ExecApprovalDecision?
    {
        let trimmedPath = socketPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty, !trimmedToken.isEmpty else { return nil }
        do {
            return try await AsyncTimeout.withTimeoutMs(
                timeoutMs: timeoutMs,
                onTimeout: {
                    TimeoutError(message: "exec approvals socket timeout")
                },
                operation: {
                    try await Task.detached {
                        try self.requestDecisionSync(
                            socketPath: trimmedPath,
                            token: trimmedToken,
                            request: request,
                            timeoutMs: timeoutMs)
                    }.value
                })
        } catch {
            return nil
        }
    }

    private static func requestDecisionSync(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest,
        timeoutMs: Int) throws -> ExecApprovalDecision?
    {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: "ExecApprovals", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "socket create failed",
            ])
        }
        defer { close(fd) }
        try configureSocketTimeouts(fd, timeoutMs: timeoutMs)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if socketPath.utf8.count >= maxLen {
            throw NSError(domain: "ExecApprovals", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "socket path too long",
            ])
        }
        socketPath.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: Int8.self)
                strncpy(raw, cstr, maxLen - 1)
            }
        }
        let size = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                connect(fd, rebound, size)
            }
        }
        if result != 0 {
            throw NSError(domain: "ExecApprovals", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "socket connect failed",
            ])
        }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)

        let message = ExecApprovalSocketRequest(
            type: "request",
            token: token,
            id: UUID().uuidString,
            request: request)
        let data = try JSONEncoder().encode(message)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)

        guard let line = try readLineFromSocket(fd, maxBytes: 256_000),
              let lineData = line.data(using: .utf8)
        else { return nil }
        let response = try JSONDecoder().decode(ExecApprovalSocketDecision.self, from: lineData)
        return response.decision
    }
}

@MainActor
final class ExecApprovalsPromptServer {
    static let shared = ExecApprovalsPromptServer()

    private let retryDelay: Duration
    private let resolveSocketCredentials: @Sendable () -> (socketPath: String, token: String)
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?
    private var server: ExecApprovalsSocketServer?
    private var retryTask: Task<Void, Never>?
    private var previousStartupTask: Task<Void, Never>?
    private var startupGeneration: UInt64 = 0

    init(
        retryDelay: Duration = .seconds(1),
        resolveSocketCredentials: @escaping @Sendable () -> (socketPath: String, token: String) = {
            let approvals = ExecApprovalsStore.resolve(agentId: nil)
            return (approvals.socketPath, approvals.token)
        },
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision? = { request in
            await ExecApprovalsPromptPresenter.prompt(request)
        })
    {
        self.retryDelay = retryDelay
        self.resolveSocketCredentials = resolveSocketCredentials
        self.onPrompt = onPrompt
    }

    func start() {
        guard self.server == nil, self.retryTask == nil else { return }
        self.startupGeneration &+= 1
        let generation = self.startupGeneration
        let retryDelay = self.retryDelay
        let resolveSocketCredentials = self.resolveSocketCredentials
        let onPrompt = self.onPrompt
        let previousStartupTask = self.previousStartupTask
        // Keep one lifecycle-owned retry loop. Blocking lock acquisition stays
        // off MainActor, while generation checks prevent post-stop installation.
        self.retryTask = Task { @MainActor [weak self] in
            // A canceled startup may still be unwinding socket-path cleanup.
            // Never let a replacement generation race that cleanup.
            if let previousStartupTask {
                await previousStartupTask.value
            }
            guard !Task.isCancelled, self?.startupGeneration == generation else { return }

            var isFirstAttempt = true
            while !Task.isCancelled {
                if isFirstAttempt {
                    isFirstAttempt = false
                } else {
                    do {
                        try await Task.sleep(for: retryDelay)
                    } catch {
                        return
                    }
                }

                let credentials = await Task.detached(priority: .utility) {
                    resolveSocketCredentials()
                }.value
                guard !Task.isCancelled,
                      let self,
                      self.startupGeneration == generation
                else { return }

                let token = credentials.token.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !token.isEmpty else { continue }

                let server = ExecApprovalsSocketServer(
                    socketPath: credentials.socketPath,
                    token: token,
                    onPrompt: onPrompt,
                    onExec: { request in
                        await ExecHostExecutor.handle(request)
                    },
                    onUnexpectedStop: { [weak self] stoppedServer in
                        Task { @MainActor [weak self] in
                            self?.handleUnexpectedStop(stoppedServer, generation: generation)
                        }
                    })
                let ready = await withTaskCancellationHandler {
                    await server.start()
                } onCancel: {
                    server.stop()
                }
                guard !Task.isCancelled, self.startupGeneration == generation else {
                    server.stop()
                    return
                }
                guard ready else {
                    server.stop()
                    continue
                }
                // The accept loop can fail after signaling readiness but before
                // this task resumes. Do not install an already-dead listener.
                guard server.isListening else {
                    server.stop()
                    continue
                }
                self.server = server
                self.retryTask = nil
                return
            }
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never>? {
        self.startupGeneration &+= 1
        let pendingRetry = self.retryTask
        pendingRetry?.cancel()
        if let pendingRetry {
            self.previousStartupTask = pendingRetry
        }
        self.retryTask = nil
        self.server?.stop()
        self.server = nil
        return pendingRetry
    }

    private func handleUnexpectedStop(
        _ stoppedServer: ExecApprovalsSocketServer,
        generation: UInt64)
    {
        guard self.startupGeneration == generation,
              self.server === stoppedServer
        else { return }
        self.server = nil
        self.start()
    }

    #if DEBUG
    func _testFailActiveSocket() {
        self.server?.failForTesting()
    }

    static func _testPrecancelledSocketStart(
        socketPath: String) async -> (ready: Bool, preservedExistingListener: Bool)
    {
        let sentinel = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "sentinel-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        guard await sentinel.start() else {
            sentinel.stop()
            return (false, false)
        }

        let socketServer = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "test-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        let startup = Task.detached {
            withUnsafeCurrentTask { task in
                task?.cancel()
            }
            return await socketServer.start()
        }
        let ready = await startup.value
        socketServer.stop()
        let preservedExistingListener = sentinel.isListening &&
            (try? ExecApprovalsSocketPathGuard.pathKind(at: socketPath)) == .socket
        sentinel.stop()
        return (ready, preservedExistingListener)
    }

    static func _testSocketLeaseHandoff(
        socketPath: String) async -> (
        replacementBlockedWhileOwned: Bool,
        replacementStartedAfterRelease: Bool,
        replacementHasDistinctIdentity: Bool,
        replacementPreserved: Bool)
    {
        let first = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "first-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        guard await first.start() else {
            first.stop()
            return (false, false, false, false)
        }
        let firstIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)

        let replacement = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "replacement-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        let replacementBlockedWhileOwned = await !replacement.start()
        first.stop()
        let replacementStartedAfterRelease = await replacement.start()
        let replacementIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)
        let currentIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)
        let result = (
            replacementBlockedWhileOwned: replacementBlockedWhileOwned,
            replacementStartedAfterRelease: replacementStartedAfterRelease,
            replacementHasDistinctIdentity: firstIdentity != nil &&
                replacementIdentity != nil &&
                firstIdentity != replacementIdentity,
            replacementPreserved: replacement.isListening && currentIdentity == replacementIdentity)
        replacement.stop()
        return result
    }

    static func _testExecHostTimestampFailureReason(_ timestamp: Int) async -> String? {
        let server = ExecApprovalsSocketServer(
            socketPath: "",
            token: "test-token",
            onPrompt: { _ in nil },
            onExec: { _ in
                ExecHostResponse(
                    type: "exec-res",
                    id: "unexpected-execution",
                    ok: true,
                    payload: nil,
                    error: nil)
            },
            onUnexpectedStop: { _ in })
        return await server.testExecHostTimestampFailureReason(timestamp)
    }
    #endif
}

enum ExecApprovalsPromptPresenter {
    @MainActor
    static func prompt(_ request: ExecApprovalPromptRequest) -> ExecApprovalDecision? {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow this command?"
        alert.informativeText = "Review the command details before allowing."
        alert.accessoryView = self.buildAccessoryView(request)

        let decisions = self.allowedPromptDecisions(request)
        for decision in decisions {
            alert.addButton(withTitle: self.buttonTitle(for: decision))
        }
        if #available(macOS 11.0, *),
           let denyIndex = decisions.firstIndex(of: .deny),
           alert.buttons.indices.contains(denyIndex)
        {
            alert.buttons[denyIndex].hasDestructiveAction = true
        }

        return self.decision(forModalResponse: alert.runModal(), decisions: decisions)
    }

    static func decision(
        forModalResponse response: NSApplication.ModalResponse,
        decisions: [ExecApprovalDecision]) -> ExecApprovalDecision?
    {
        let selectedIndex = response.rawValue
            - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if decisions.indices.contains(selectedIndex) {
            return decisions[selectedIndex]
        }
        return decisions.contains(.deny) ? .deny : nil
    }

    static func allowedPromptDecisions(_ request: ExecApprovalPromptRequest) -> [ExecApprovalDecision] {
        if let allowedDecisions = request.allowedDecisions, !allowedDecisions.isEmpty {
            return allowedDecisions
        }
        return ExecApprovalPromptRequest.allowedDecisions(forAsk: request.ask)
    }

    private static func buttonTitle(for decision: ExecApprovalDecision) -> String {
        switch decision {
        case .allowOnce:
            "Allow Once"
        case .allowAlways:
            "Always Allow"
        case .deny:
            "Don't Allow"
        }
    }

    @MainActor
    static func buildAccessoryView(_ request: ExecApprovalPromptRequest) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 8
        stack.alignment = .leading
        stack.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true

        let commandTitle = NSTextField(labelWithString: "Command")
        commandTitle.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(commandTitle)

        let commandText = NSTextView()
        commandText.isEditable = false
        commandText.isSelectable = true
        commandText.drawsBackground = true
        commandText.backgroundColor = NSColor.textBackgroundColor
        commandText.font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        commandText.string = ExecApprovalCommandDisplaySanitizer.sanitize(request.command)
        commandText.textContainerInset = NSSize(width: 6, height: 6)
        commandText.textContainer?.lineFragmentPadding = 0
        commandText.textContainer?.widthTracksTextView = true
        commandText.isHorizontallyResizable = false
        commandText.isVerticallyResizable = true

        let commandScroll = NSScrollView()
        commandScroll.borderType = .lineBorder
        commandScroll.hasVerticalScroller = true
        commandScroll.hasHorizontalScroller = false
        commandScroll.autohidesScrollers = true
        commandScroll.documentView = commandText
        commandScroll.translatesAutoresizingMaskIntoConstraints = false
        commandScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true
        commandScroll.widthAnchor.constraint(lessThanOrEqualToConstant: 440).isActive = true
        commandScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        commandScroll.heightAnchor.constraint(lessThanOrEqualToConstant: 120).isActive = true
        stack.addArrangedSubview(commandScroll)

        let contextTitle = NSTextField(labelWithString: "Context")
        contextTitle.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(contextTitle)

        let contextStack = NSStackView()
        contextStack.orientation = .vertical
        contextStack.spacing = 4
        contextStack.alignment = .leading

        if let cwd = self.sanitizedContextValue(request.cwd) {
            self.addDetailRow(title: "Working directory", value: cwd, to: contextStack)
        }
        if let agent = self.sanitizedContextValue(request.agentId) {
            self.addDetailRow(title: "Agent", value: agent, to: contextStack)
        }
        if let path = self.sanitizedContextValue(request.resolvedPath) {
            self.addDetailRow(title: "Executable", value: path, to: contextStack)
        }
        if let host = self.sanitizedContextValue(request.host) {
            self.addDetailRow(title: "Host", value: host, to: contextStack)
        }
        if let security = self.sanitizedContextValue(request.security) {
            self.addDetailRow(title: "Security", value: security, to: contextStack)
        }
        if let ask = self.sanitizedContextValue(request.ask) {
            self.addDetailRow(title: "Ask mode", value: ask, to: contextStack)
        }

        if contextStack.arrangedSubviews.isEmpty {
            let empty = NSTextField(labelWithString: "No additional context provided.")
            empty.textColor = NSColor.secondaryLabelColor
            empty.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
            contextStack.addArrangedSubview(empty)
        }

        stack.addArrangedSubview(contextStack)

        let footer = NSTextField(labelWithString: "This runs on this machine.")
        footer.textColor = NSColor.secondaryLabelColor
        footer.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        stack.addArrangedSubview(footer)

        // NSAlert reserves accessory space from the view frame, not from Auto Layout constraints.
        // Give the top-level accessory an explicit frame so its subviews do not paint over the
        // alert title, message, and buttons while the frame remains zero-sized.
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)
        return stack
    }

    static func sanitizedContextValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return ExecApprovalCommandDisplaySanitizer.sanitize(trimmed)
    }

    @MainActor
    private static func addDetailRow(title: String, value: String, to stack: NSStackView) {
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .firstBaseline

        let titleLabel = NSTextField(labelWithString: "\(title):")
        titleLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        titleLabel.textColor = NSColor.secondaryLabelColor

        let valueLabel = NSTextField(labelWithString: value)
        valueLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        valueLabel.lineBreakMode = .byTruncatingMiddle
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        row.addArrangedSubview(titleLabel)
        row.addArrangedSubview(valueLabel)
        stack.addArrangedSubview(row)
    }
}

@MainActor
private enum ExecHostExecutor {
    static func handle(_ request: ExecHostRequest) async -> ExecHostResponse {
        let validatedRequest: ExecHostValidatedRequest
        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(request):
            validatedRequest = request
        case let .failure(error):
            return self.errorResponse(error)
        }

        let context = await self.buildContext(
            request: request,
            command: validatedRequest.command,
            rawCommand: validatedRequest.evaluationRawCommand,
            displayCommand: validatedRequest.displayCommand)
        let approvalSource = validatedRequest.approvalSource
        let security = ExecHostRequestEvaluator.effectiveSecurity(
            context: context,
            approvalSource: approvalSource)
        var explicitlyApproved = approvalSource == .autoReview ||
            request.approvalDecision == .allowOnce ||
            request.approvalDecision == .allowAlways
        var persistAllowlist = request.approvalDecision == .allowAlways

        switch ExecHostRequestEvaluator.evaluate(
            context: context,
            approvalDecision: request.approvalDecision,
            approvalSource: approvalSource)
        {
        case let .deny(error):
            return self.errorResponse(error)
        case .allow:
            break
        case .requiresPrompt:
            guard let decision = ExecApprovalsPromptPresenter.prompt(
                ExecApprovalPromptRequest(
                    command: context.displayCommand,
                    cwd: request.cwd,
                    host: "node",
                    security: context.security.rawValue,
                    ask: context.ask.rawValue,
                    agentId: context.agentId,
                    resolvedPath: context.resolution?.resolvedPath,
                    sessionKey: request.sessionKey,
                    allowedDecisions: ExecApprovalPromptRequest.allowedDecisions(
                        forAsk: context.ask.rawValue,
                        allowAlwaysEligible: context.canPersistAllowAlways)))
            else {
                return self.errorResponse(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: approval prompt closed without decision",
                    reason: "approval-cancelled")
            }

            let followupDecision: ExecApprovalDecision
            switch decision {
            case .deny:
                followupDecision = .deny
            case .allowAlways:
                explicitlyApproved = true
                followupDecision = .allowAlways
            case .allowOnce:
                explicitlyApproved = true
                followupDecision = .allowOnce
            }
            persistAllowlist = followupDecision == .allowAlways

            switch ExecHostRequestEvaluator.evaluate(
                context: context,
                approvalDecision: followupDecision,
                approvalSource: approvalSource)
            {
            case let .deny(error):
                return self.errorResponse(error)
            case .allow:
                break
            case .requiresPrompt:
                return self.errorResponse(
                    code: "INVALID_REQUEST",
                    message: "unexpected approval state",
                    reason: "invalid")
            }
        }

        let authorizationBasis = context.authorizationBasis
        let reusableAuthorization = security == .allowlist &&
            !explicitlyApproved &&
            authorizationBasis != nil

        let executionCommand: [String]
        if reusableAuthorization {
            guard let boundCommand = context.boundCommand else {
                return self.errorResponse(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: reusable approval could not bind executable",
                    reason: "allowlist-unbound")
            }
            executionCommand = boundCommand
        } else {
            executionCommand = validatedRequest.command
        }

        if let errorResponse = await self.ensureScreenRecordingAccess(request.needsScreenRecording) {
            return errorResponse
        }

        let executionCommit = ExecApprovalExecutionCommit.build(
            context: context,
            effectiveSecurity: security,
            approvalSource: approvalSource,
            explicitlyApproved: explicitlyApproved,
            persistAllowlist: persistAllowlist)
        let timeoutSec = request.timeoutMs.flatMap { Double($0) / 1000.0 }
        let cwd = request.cwd
        let env = context.env
        if case .failure = ExecApprovalsStore.commitExecution(executionCommit) {
            return self.approvalStoreErrorResponse()
        }

        // The store commit linearizes authorization. Enqueue before the next
        // suspension so no unrelated MainActor work sits between those steps.
        let execution = Task.detached { () -> ShellExecutor.ShellResult in
            await ShellExecutor.runDetailed(
                command: executionCommand,
                cwd: cwd,
                env: env,
                timeout: timeoutSec)
        }
        return await self.commandResponse(execution: execution)
    }

    private static func buildContext(
        request: ExecHostRequest,
        command: [String],
        rawCommand: String?,
        displayCommand: String) async -> ExecApprovalEvaluation
    {
        await ExecApprovalEvaluator.evaluate(
            command: command,
            rawCommand: rawCommand,
            displayCommand: displayCommand,
            cwd: request.cwd,
            envOverrides: request.env,
            agentId: request.agentId)
    }

    private static func approvalStoreErrorResponse() -> ExecHostResponse {
        self.errorResponse(
            code: "UNAVAILABLE",
            message: "SYSTEM_RUN_DENIED: exec approvals update unavailable",
            reason: "approval-store-unavailable")
    }

    private static func ensureScreenRecordingAccess(_ needsScreenRecording: Bool?) async -> ExecHostResponse? {
        guard needsScreenRecording == true else { return nil }
        let authorized = await PermissionManager
            .status([.screenRecording])[.screenRecording] ?? false
        if authorized {
            return nil
        }
        return self.errorResponse(
            code: "UNAVAILABLE",
            message: "PERMISSION_MISSING: screenRecording",
            reason: "permission:screenRecording")
    }

    private static func commandResponse(
        execution: Task<ShellExecutor.ShellResult, Never>) async -> ExecHostResponse
    {
        let result = await execution.value
        let payload = ExecHostRunResult(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: ExecHostOutputLimiter.truncate(result.stdout),
            stderr: ExecHostOutputLimiter.truncate(result.stderr),
            error: result.errorMessage)
        return self.successResponse(payload)
    }

    private static func errorResponse(
        _ error: ExecHostError) -> ExecHostResponse
    {
        ExecHostResponse(
            type: "response",
            id: UUID().uuidString,
            ok: false,
            payload: nil,
            error: error)
    }

    private static func errorResponse(
        code: String,
        message: String,
        reason: String?) -> ExecHostResponse
    {
        ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: false,
            payload: nil,
            error: ExecHostError(code: code, message: message, reason: reason))
    }

    private static func successResponse(_ payload: ExecHostRunResult) -> ExecHostResponse {
        ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: true,
            payload: payload,
            error: nil)
    }
}

private final class ExecApprovalsSocketLifecycleLease: @unchecked Sendable {
    private static let processLock = NSLock()
    private nonisolated(unsafe) static var reservedPaths = Set<String>()

    private let descriptor: Int32
    private let path: String
    private let stateLock = NSLock()
    private var released = false

    private init(descriptor: Int32, path: String) {
        self.descriptor = descriptor
        self.path = path
    }

    static func acquire(for socketPath: String) throws -> ExecApprovalsSocketLifecycleLease {
        let socketURL = URL(fileURLWithPath: socketPath).standardizedFileURL
        let canonicalSocketPath = socketURL.deletingLastPathComponent()
            .resolvingSymlinksInPath()
            .appendingPathComponent(socketURL.lastPathComponent)
            .path
        let lockPath = "\(canonicalSocketPath).lifecycle.lock"
        let reserved = self.processLock.withLock { () -> Bool in
            guard !self.reservedPaths.contains(lockPath) else { return false }
            self.reservedPaths.insert(lockPath)
            return true
        }
        guard reserved else {
            throw ExecApprovalsSocketPathGuardError.lifecycleLockBusy(path: lockPath)
        }

        let descriptor = open(
            lockPath,
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            self.releaseProcessReservation(lockPath)
            throw ExecApprovalsSocketPathGuardError.lifecycleLockOpenFailed(
                path: lockPath,
                code: errno)
        }

        do {
            var descriptorStatus = stat()
            var pathStatus = stat()
            guard fstat(descriptor, &descriptorStatus) == 0,
                  lstat(lockPath, &pathStatus) == 0,
                  descriptorStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  descriptorStatus.st_uid == geteuid(),
                  descriptorStatus.st_nlink == 1,
                  descriptorStatus.st_mode & mode_t(0o022) == 0,
                  descriptorStatus.st_dev == pathStatus.st_dev,
                  descriptorStatus.st_ino == pathStatus.st_ino
            else {
                throw ExecApprovalsSocketPathGuardError.lifecycleLockInvalid(path: lockPath)
            }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw ExecApprovalsSocketPathGuardError.lifecycleLockBusy(path: lockPath)
            }
            return ExecApprovalsSocketLifecycleLease(
                descriptor: descriptor,
                path: lockPath)
        } catch {
            close(descriptor)
            self.releaseProcessReservation(lockPath)
            throw error
        }
    }

    func release() {
        let shouldRelease = self.stateLock.withLock { () -> Bool in
            guard !self.released else { return false }
            self.released = true
            return true
        }
        guard shouldRelease else { return }
        _ = flock(self.descriptor, LOCK_UN)
        close(self.descriptor)
        Self.releaseProcessReservation(self.path)
    }

    deinit {
        self.release()
    }

    private static func releaseProcessReservation(_ path: String) {
        self.processLock.withLock {
            self.reservedPaths.remove(path)
        }
    }
}

private final class ExecApprovalsSocketServer: @unchecked Sendable {
    private struct OpenedSocket {
        let fd: Int32
        let identity: ExecApprovalsSocketPathIdentity
        let lifecycleLease: ExecApprovalsSocketLifecycleLease
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.socket")
    private let socketPath: String
    private let token: String
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?
    private let onExec: @Sendable (ExecHostRequest) async -> ExecHostResponse
    private let onUnexpectedStop: @Sendable (ExecApprovalsSocketServer) -> Void
    private let stateLock = NSLock()
    private var socketFD: Int32 = -1
    private var socketIdentity: ExecApprovalsSocketPathIdentity?
    private var socketLifecycleLease: ExecApprovalsSocketLifecycleLease?
    private var acceptTask: Task<Void, Never>?
    private var isRunning = false

    init(
        socketPath: String,
        token: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?,
        onExec: @escaping @Sendable (ExecHostRequest) async -> ExecHostResponse,
        onUnexpectedStop: @escaping @Sendable (ExecApprovalsSocketServer) -> Void)
    {
        self.socketPath = socketPath
        self.token = token
        self.onPrompt = onPrompt
        self.onExec = onExec
        self.onUnexpectedStop = onUnexpectedStop
    }

    var isListening: Bool {
        self.stateLock.withLock { self.isRunning && self.socketFD >= 0 }
    }

    func start() async -> Bool {
        let shouldStart = self.stateLock.withLock {
            guard !Task.isCancelled, !self.isRunning else { return false }
            self.isRunning = true
            return true
        }
        guard shouldStart else {
            return self.stateLock.withLock { self.socketFD >= 0 }
        }

        return await withCheckedContinuation { continuation in
            let task = Task.detached { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                await self.runAcceptLoop { ready in
                    continuation.resume(returning: ready)
                }
            }
            self.stateLock.withLock {
                self.acceptTask = task
                if !self.isRunning {
                    task.cancel()
                }
            }
        }
    }

    func stop() {
        let (task, fd, identity, lifecycleLease) = self.stateLock.withLock {
            self.isRunning = false
            let task = self.acceptTask
            self.acceptTask = nil
            let fd = self.socketFD
            self.socketFD = -1
            let identity = self.socketIdentity
            self.socketIdentity = nil
            let lifecycleLease = self.socketLifecycleLease
            self.socketLifecycleLease = nil
            return (task, fd, identity, lifecycleLease)
        }
        task?.cancel()
        self.closeOwnedSocket(
            fd: fd,
            identity: identity,
            lifecycleLease: lifecycleLease)
    }

    private func runAcceptLoop(onReady: @escaping @Sendable (Bool) -> Void) async {
        let shouldOpen = self.stateLock.withLock { self.isRunning && !Task.isCancelled }
        guard shouldOpen else {
            self.stateLock.withLock {
                self.isRunning = false
                self.acceptTask = nil
            }
            onReady(false)
            return
        }

        guard let openedSocket = self.openSocket() else {
            self.stateLock.withLock {
                self.isRunning = false
                self.acceptTask = nil
            }
            onReady(false)
            return
        }
        let fd = openedSocket.fd

        let shouldAccept = self.stateLock.withLock {
            guard self.isRunning, !Task.isCancelled else { return false }
            self.socketFD = fd
            self.socketIdentity = openedSocket.identity
            self.socketLifecycleLease = openedSocket.lifecycleLease
            return true
        }
        guard shouldAccept else {
            self.closeOwnedSocket(
                fd: fd,
                identity: openedSocket.identity,
                lifecycleLease: openedSocket.lifecycleLease)
            onReady(false)
            return
        }

        onReady(true)
        while self.stateLock.withLock({ self.isRunning }), !Task.isCancelled {
            var addr = sockaddr_un()
            var len = socklen_t(MemoryLayout.size(ofValue: addr))
            let client = withUnsafeMutablePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                    accept(fd, rebound, &len)
                }
            }
            if client < 0 {
                if errno == EINTR {
                    continue
                }
                break
            }
            Task.detached { [weak self] in
                await self?.handleClient(fd: client)
            }
        }

        let termination = self.stateLock.withLock {
            let stoppedUnexpectedly = self.isRunning && !Task.isCancelled
            let ownsDescriptor = self.socketFD == fd
            if ownsDescriptor {
                self.socketFD = -1
            }
            let identity = ownsDescriptor ? self.socketIdentity : nil
            let lifecycleLease = ownsDescriptor ? self.socketLifecycleLease : nil
            if ownsDescriptor {
                self.socketIdentity = nil
                self.socketLifecycleLease = nil
            }
            self.isRunning = false
            self.acceptTask = nil
            return (
                ownsDescriptor: ownsDescriptor,
                identity: identity,
                lifecycleLease: lifecycleLease,
                stoppedUnexpectedly: stoppedUnexpectedly)
        }
        if termination.ownsDescriptor {
            self.closeOwnedSocket(
                fd: fd,
                identity: termination.identity,
                lifecycleLease: termination.lifecycleLease)
        }
        if termination.stoppedUnexpectedly {
            self.onUnexpectedStop(self)
        }
    }

    private func closeOwnedSocket(
        fd: Int32,
        identity: ExecApprovalsSocketPathIdentity?,
        lifecycleLease: ExecApprovalsSocketLifecycleLease?)
    {
        if fd >= 0 {
            close(fd)
        }
        if !self.socketPath.isEmpty, let identity {
            do {
                // Keep the cross-process lease through the identity check and
                // unlink so no replacement can bind between those operations.
                try ExecApprovalsSocketPathGuard.removeSocket(
                    at: self.socketPath,
                    ifIdentityMatches: identity)
            } catch {
                self.logger
                    .warning("exec approvals socket cleanup failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        lifecycleLease?.release()
    }

    #if DEBUG
    fileprivate func failForTesting() {
        let shutdown: (
            task: Task<Void, Never>?,
            fd: Int32,
            identity: ExecApprovalsSocketPathIdentity?,
            lifecycleLease: ExecApprovalsSocketLifecycleLease?) = self.stateLock.withLock {
            guard self.isRunning, self.socketFD >= 0 else {
                return (task: nil, fd: -1, identity: nil, lifecycleLease: nil)
            }
            self.isRunning = false
            let task = self.acceptTask
            self.acceptTask = nil
            let fd = self.socketFD
            self.socketFD = -1
            let identity = self.socketIdentity
            self.socketIdentity = nil
            let lifecycleLease = self.socketLifecycleLease
            self.socketLifecycleLease = nil
            return (task: task, fd: fd, identity: identity, lifecycleLease: lifecycleLease)
        }
        guard shutdown.fd >= 0 else { return }
        shutdown.task?.cancel()
        self.closeOwnedSocket(
            fd: shutdown.fd,
            identity: shutdown.identity,
            lifecycleLease: shutdown.lifecycleLease)
        self.onUnexpectedStop(self)
    }
    #endif

    private func openSocket() -> OpenedSocket? {
        let lifecycleLease: ExecApprovalsSocketLifecycleLease
        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: self.socketPath)
            lifecycleLease = try ExecApprovalsSocketLifecycleLease.acquire(for: self.socketPath)
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
        } catch {
            self.logger
                .error("exec approvals socket path hardening failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            self.logger.error("exec approvals socket create failed")
            lifecycleLease.release()
            return nil
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if self.socketPath.utf8.count >= maxLen {
            self.logger.error("exec approvals socket path too long")
            close(fd)
            lifecycleLease.release()
            return nil
        }
        self.socketPath.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: Int8.self)
                memset(raw, 0, maxLen)
                strncpy(raw, cstr, maxLen - 1)
            }
        }
        let size = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                bind(fd, rebound, size)
            }
        }
        if result != 0 {
            self.logger.error("exec approvals socket bind failed")
            close(fd)
            lifecycleLease.release()
            return nil
        }
        let identity: ExecApprovalsSocketPathIdentity
        do {
            guard let boundIdentity = try ExecApprovalsSocketPathGuard.socketIdentity(at: self.socketPath) else {
                self.logger.error("exec approvals socket identity unavailable after bind")
                close(fd)
                try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
                lifecycleLease.release()
                return nil
            }
            identity = boundIdentity
        } catch {
            self.logger.error(
                "exec approvals socket identity failed: \(error.localizedDescription, privacy: .public)")
            close(fd)
            try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
            lifecycleLease.release()
            return nil
        }
        if chmod(self.socketPath, 0o600) != 0 {
            self.logger.error("exec approvals socket chmod failed")
            self.closeOwnedSocket(
                fd: fd,
                identity: identity,
                lifecycleLease: lifecycleLease)
            return nil
        }
        if listen(fd, 16) != 0 {
            self.logger.error("exec approvals socket listen failed")
            self.closeOwnedSocket(
                fd: fd,
                identity: identity,
                lifecycleLease: lifecycleLease)
            return nil
        }
        self.logger.info("exec approvals socket listening at \(self.socketPath, privacy: .public)")
        return OpenedSocket(
            fd: fd,
            identity: identity,
            lifecycleLease: lifecycleLease)
    }

    private func handleClient(fd: Int32) async {
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            guard self.isAllowedPeer(fd: fd) else {
                try self.sendApprovalResponse(handle: handle, id: UUID().uuidString, decision: .deny)
                return
            }
            try configureSocketTimeouts(fd, timeoutMs: 15000)
            guard let line = try readLineFromSocket(fd, maxBytes: 256_000),
                  let data = line.data(using: .utf8)
            else {
                return
            }
            guard
                let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let type = envelope["type"] as? String
            else {
                return
            }

            if type == "request" {
                let request = try JSONDecoder().decode(ExecApprovalSocketRequest.self, from: data)
                guard request.token == self.token else {
                    try self.sendApprovalResponse(handle: handle, id: request.id, decision: .deny)
                    return
                }
                guard let decision = await self.onPrompt(request.request) else { return }
                try self.sendApprovalResponse(handle: handle, id: request.id, decision: decision)
                return
            }

            if type == "exec" {
                let request = try JSONDecoder().decode(ExecHostSocketRequest.self, from: data)
                let response = await self.handleExecRequest(request)
                try self.sendExecResponse(handle: handle, response: response)
                return
            }
        } catch {
            self.logger.error("exec approvals socket handling failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendApprovalResponse(
        handle: FileHandle,
        id: String,
        decision: ExecApprovalDecision) throws
    {
        let response = ExecApprovalSocketDecision(type: "decision", id: id, decision: decision)
        let data = try JSONEncoder().encode(response)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)
    }

    private func sendExecResponse(handle: FileHandle, response: ExecHostResponse) throws {
        let data = try JSONEncoder().encode(response)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)
    }

    private func isAllowedPeer(fd: Int32) -> Bool {
        var uid = uid_t(0)
        var gid = gid_t(0)
        if getpeereid(fd, &uid, &gid) != 0 {
            return false
        }
        return uid == geteuid()
    }

    private func handleExecRequest(_ request: ExecHostSocketRequest) async -> ExecHostResponse {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        if !execHostTimestampIsFresh(nowMs: nowMs, requestMs: request.ts) {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "expired request", reason: "ttl"))
        }
        let expected = self.hmacHex(nonce: request.nonce, ts: request.ts, requestJson: request.requestJson)
        if !timingSafeHexStringEquals(expected, request.hmac) {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "invalid auth", reason: "hmac"))
        }
        guard let requestData = request.requestJson.data(using: .utf8),
              let payload = try? JSONDecoder().decode(ExecHostRequest.self, from: requestData)
        else {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "invalid payload", reason: "json"))
        }
        let response = await self.onExec(payload)
        return ExecHostResponse(
            type: "exec-res",
            id: request.id,
            ok: response.ok,
            payload: response.payload,
            error: response.error)
    }

    #if DEBUG
    fileprivate func testExecHostTimestampFailureReason(_ timestamp: Int) async -> String? {
        let response = await self.handleExecRequest(ExecHostSocketRequest(
            type: "exec",
            id: "timestamp-test",
            nonce: "nonce",
            ts: timestamp,
            hmac: "unauthenticated",
            requestJson: #"{"command":["/usr/bin/true"]}"#))
        return response.error?.reason
    }
    #endif

    private func hmacHex(nonce: String, ts: Int, requestJson: String) -> String {
        let key = SymmetricKey(data: Data(self.token.utf8))
        let message = "\(nonce):\(ts):\(requestJson)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}
