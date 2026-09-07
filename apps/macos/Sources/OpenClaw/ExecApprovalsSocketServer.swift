import CryptoKit
import Darwin
import Foundation
import OSLog

final class ExecApprovalsSocketServer: @unchecked Sendable {
    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.socket")
    private let token: String
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?
    private let onExec: @Sendable (ExecHostRequest) async -> ExecHostResponse
    private let onUnexpectedStop: @Sendable (ExecApprovalsSocketServer) -> Void
    private let listener: LocalSocketServer

    init(
        socketPath: String,
        token: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?,
        onExec: @escaping @Sendable (ExecHostRequest) async -> ExecHostResponse,
        onUnexpectedStop: @escaping @Sendable (ExecApprovalsSocketServer) -> Void)
    {
        self.token = token
        self.onPrompt = onPrompt
        self.onExec = onExec
        self.onUnexpectedStop = onUnexpectedStop
        self.listener = LocalSocketServer(
            socketPath: socketPath,
            logger: Logger(subsystem: "ai.openclaw", category: "exec-approvals.socket"))
    }

    var isListening: Bool {
        self.listener.isListening
    }

    func start() async -> Bool {
        await self.listener.start(handler: { handle in
            await self.handleClient(handle: handle)
        }, onUnexpectedStop: {
            self.onUnexpectedStop(self)
        })
    }

    @discardableResult
    func stop() -> Task<Void, Never> {
        self.listener.stop()
    }

    #if DEBUG
    func failForTesting() {
        guard self.isListening else { return }
        self.stop()
        self.onUnexpectedStop(self)
    }
    #endif

    private func handleClient(handle: FileHandle) async {
        let fd = handle.fileDescriptor
        do {
            try Task.checkCancellation()
            guard self.isAllowedPeer(fd: fd) else {
                try self.sendApprovalResponse(handle: handle, id: UUID().uuidString, decision: .deny)
                return
            }
            try configureSocketTimeouts(fd, timeoutMs: execApprovalsSocketTimeoutMs)
            guard let line = try readLineFromSocket(fd, maxBytes: 256_000),
                  let data = line.data(using: .utf8)
            else {
                return
            }
            try Task.checkCancellation()
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
                try Task.checkCancellation()
                try self.sendApprovalResponse(handle: handle, id: request.id, decision: decision)
                return
            }

            if type == "exec" {
                let request = try JSONDecoder().decode(ExecHostSocketRequest.self, from: data)
                let response = await self.handleExecRequest(request)
                try Task.checkCancellation()
                try self.sendResponse(handle: handle, response: response)
                return
            }
        } catch {
            if !Task.isCancelled {
                self.logger
                    .error("exec approvals socket handling failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func sendApprovalResponse(
        handle: FileHandle,
        id: String,
        decision: ExecApprovalDecision) throws
    {
        let response = ExecApprovalSocketDecision(type: "decision", id: id, decision: decision)
        try self.sendResponse(handle: handle, response: response)
    }

    private func sendResponse(handle: FileHandle, response: some Encodable) throws {
        var payload = try JSONEncoder().encode(response)
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

    private func hmacHex(nonce: String, ts: Int, requestJson: String) -> String {
        let key = SymmetricKey(data: Data(self.token.utf8))
        let message = "\(nonce):\(ts):\(requestJson)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}
