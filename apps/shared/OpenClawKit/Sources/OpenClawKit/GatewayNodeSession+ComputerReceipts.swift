import CryptoKit
import Foundation

struct NodeInvokeRequestPayload: Codable {
    var id: String
    var nodeId: String
    var command: String
    var paramsJSON: String?
    var timeoutMs: Int?
    var idempotencyKey: String?
    var sessionKey: String?
    var hasSessionKeyEnvelope: Bool

    private enum CodingKeys: String, CodingKey {
        case id
        case nodeId
        case command
        case paramsJSON
        case timeoutMs
        case idempotencyKey
        case sessionKey
    }

    init(
        id: String,
        nodeId: String,
        command: String,
        paramsJSON: String?,
        timeoutMs: Int?,
        idempotencyKey: String?,
        sessionKey: String? = nil,
        hasSessionKeyEnvelope: Bool = false)
    {
        self.id = id
        self.nodeId = nodeId
        self.command = command
        self.paramsJSON = paramsJSON
        self.timeoutMs = timeoutMs
        self.idempotencyKey = idempotencyKey
        self.sessionKey = sessionKey
        self.hasSessionKeyEnvelope = hasSessionKeyEnvelope
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.nodeId = try container.decode(String.self, forKey: .nodeId)
        self.command = try container.decode(String.self, forKey: .command)
        self.paramsJSON = try container.decodeIfPresent(String.self, forKey: .paramsJSON)
        self.timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs)
        self.idempotencyKey = try container.decodeIfPresent(String.self, forKey: .idempotencyKey)
        self.hasSessionKeyEnvelope = container.contains(.sessionKey)
        let sessionKey = try container.decodeIfPresent(String.self, forKey: .sessionKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.sessionKey = sessionKey?.isEmpty == false ? sessionKey : nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.nodeId, forKey: .nodeId)
        try container.encode(self.command, forKey: .command)
        try container.encodeIfPresent(self.paramsJSON, forKey: .paramsJSON)
        try container.encodeIfPresent(self.timeoutMs, forKey: .timeoutMs)
        try container.encodeIfPresent(self.idempotencyKey, forKey: .idempotencyKey)
        if self.hasSessionKeyEnvelope {
            try container.encode(self.sessionKey, forKey: .sessionKey)
        }
    }
}

enum NodeInvokeSessionEnvelopeMode: Equatable, Sendable {
    case authoritative
    case legacy
}

struct NodeInvokeRequestContext: Sendable {
    let envelopeMode: NodeInvokeSessionEnvelopeMode
    let route: GatewayNodeSessionRoute
    let receiptScope: String
    let channel: GatewayChannelActor
    let socketGeneration: UInt64
    let receivedAt: ContinuousClock.Instant
}

enum ComputerInvokeReceiptState {
    case inFlight(Task<BridgeInvokeResponse, Never>)
    case completed(BridgeInvokeResponse)

    var isCompleted: Bool {
        if case .completed = self {
            return true
        }
        return false
    }
}

struct ComputerInvokeReceipt {
    let id: UUID
    let fingerprint: String
    var state: ComputerInvokeReceiptState
    var operationStarted: Bool
    var operationSettled: Bool
}

struct ComputerInvokeReceiptKey: Hashable {
    let receiptScopeBytes: [UInt8]
    let idempotencyKeyBytes: [UInt8]

    init(receiptScope: String, idempotencyKey: String) {
        self.receiptScopeBytes = Array(receiptScope.utf8)
        self.idempotencyKeyBytes = Array(idempotencyKey.utf8)
    }
}

extension GatewayNodeSession {
    static func staleRouteInvokeResponse(requestId: String) -> BridgeInvokeResponse {
        BridgeInvokeResponse(
            id: requestId,
            ok: false,
            error: OpenClawNodeError(
                code: .unavailable,
                message: self.staleRouteInvokeMessage))
    }

    func invokeWithComputerReceipt(
        requestPayload: NodeInvokeRequestPayload,
        request: BridgeInvokeRequest,
        timeoutMs: Int?,
        receiptScope: String,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async
        -> BridgeInvokeResponse
    {
        let timeout = timeoutMs.map { min(max(0, $0), Self.maxInvokeTimeoutMs) }
            ?? Self.defaultInvokeTimeoutMs
        let deadline = timeout > 0
            ? ContinuousClock.now.advanced(by: .milliseconds(timeout))
            : nil
        return await self.invokeWithComputerReceipt(
            requestPayload: requestPayload,
            request: request,
            deadline: deadline,
            receiptScope: receiptScope,
            onInvoke: onInvoke,
            retryStaleJoinedReceipt: true)
    }

    private func invokeWithComputerReceipt(
        requestPayload: NodeInvokeRequestPayload,
        request: BridgeInvokeRequest,
        deadline: ContinuousClock.Instant?,
        receiptScope: String,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        retryStaleJoinedReceipt: Bool) async
        -> BridgeInvokeResponse
    {
        let idempotencyKey = requestPayload.idempotencyKey?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard requestPayload.command == "computer.act", !idempotencyKey.isEmpty else {
            return await Self.invokeWithComputerDeadline(
                request: request,
                deadline: deadline,
                onInvoke: onInvoke)
        }

        let receiptKey = ComputerInvokeReceiptKey(
            receiptScope: receiptScope,
            idempotencyKey: idempotencyKey)
        let fingerprint = Self.computerInvokeFingerprint(requestPayload)
        if let receipt = computerInvokeReceipts[receiptKey] {
            guard receipt.fingerprint == fingerprint else {
                return BridgeInvokeResponse(
                    id: request.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .invalidRequest,
                        message: "INVALID_REQUEST: computer.act idempotency key reused with different parameters"))
            }
            #if DEBUG
            self.computerInvokeReceiptJoinCounts[receipt.id, default: 0] += 1
            #endif
            let response = switch receipt.state {
            case let .inFlight(task):
                // A duplicate joins the shared side effect but keeps its own deadline.
                // Timing out this wait must not cancel the original receipt task.
                await Self.invokeWithComputerDeadline(
                    request: request,
                    deadline: deadline,
                    onInvoke: { _ in await task.value })
            case let .completed(response): response
            }
            self.discardRetryableComputerInvokeReceipt(
                key: receiptKey,
                receiptID: receipt.id,
                fingerprint: fingerprint,
                response: response)
            if retryStaleJoinedReceipt, Self.isStaleRouteInvokeResponse(response) {
                // A reconnect retry can join the old route's in-flight receipt.
                // Once that receipt proves it never dispatched, retry exactly once
                // with this request's route-bound invoke closure.
                return await self.invokeWithComputerReceipt(
                    requestPayload: requestPayload,
                    request: request,
                    deadline: deadline,
                    receiptScope: receiptScope,
                    onInvoke: onInvoke,
                    retryStaleJoinedReceipt: false)
            }
            return Self.rebindInvokeResponse(response, requestId: request.id)
        }

        guard self.makeComputerInvokeReceiptCapacity() else {
            return BridgeInvokeResponse(
                id: request.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "UNAVAILABLE: computer.act receipt capacity exhausted"))
        }

        let receiptID = UUID()
        let task = Task { [self] in
            await Self.invokeWithComputerDeadline(
                request: request,
                deadline: deadline,
                onInvoke: onInvoke,
                onOperationStarted: { [weak self] in
                    await self?.markComputerInvokeOperationStarted(
                        key: receiptKey,
                        receiptID: receiptID,
                        fingerprint: fingerprint)
                },
                onOperationSettled: { [weak self] in
                    await self?.markComputerInvokeOperationSettled(
                        key: receiptKey,
                        receiptID: receiptID,
                        fingerprint: fingerprint)
                })
        }
        self.computerInvokeReceipts[receiptKey] = ComputerInvokeReceipt(
            id: receiptID,
            fingerprint: fingerprint,
            state: .inFlight(task),
            operationStarted: false,
            operationSettled: false)
        self.computerInvokeReceiptOrder.append(receiptKey)
        let response = await task.value
        if Self.isStaleRouteInvokeResponse(response) {
            self.discardRetryableComputerInvokeReceipt(
                key: receiptKey,
                receiptID: receiptID,
                fingerprint: fingerprint,
                response: response)
        } else if let receipt = self.computerInvokeReceipts[receiptKey],
                  receipt.id == receiptID,
                  receipt.fingerprint == fingerprint
        {
            if receipt.operationStarted {
                self.computerInvokeReceipts[receiptKey]?.state = .completed(response)
            } else {
                // No side effect could have started, so a retry must get a fresh
                // receipt instead of inheriting this pre-dispatch timeout.
                self.discardComputerInvokeReceipt(
                    key: receiptKey,
                    receiptID: receiptID,
                    fingerprint: fingerprint)
            }
        }
        return Self.rebindInvokeResponse(response, requestId: request.id)
    }

    private static func invokeWithComputerDeadline(
        request: BridgeInvokeRequest,
        deadline: ContinuousClock.Instant?,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onOperationStarted: (@Sendable () async -> Void)? = nil,
        onOperationSettled: (@Sendable () async -> Void)? = nil) async -> BridgeInvokeResponse
    {
        guard let deadline else {
            return await invokeWithTimeout(
                request: request,
                timeoutMs: 0,
                onInvoke: onInvoke,
                onOperationStarted: onOperationStarted,
                onOperationSettled: onOperationSettled)
        }
        let remaining = ContinuousClock.now.duration(to: deadline)
        guard remaining > .zero else {
            await onOperationSettled?()
            return invokeTimeoutResponse(requestId: request.id)
        }
        let components = remaining.components
        let remainingMs = max(
            1,
            Int(components.seconds) * 1000 +
                Int(components.attoseconds / 1_000_000_000_000_000))
        return await invokeWithTimeout(
            request: request,
            timeoutMs: remainingMs,
            onInvoke: onInvoke,
            onOperationStarted: onOperationStarted,
            onOperationSettled: onOperationSettled)
    }

    #if DEBUG
    // periphery:ignore - package tests exercise receipt dedupe around the private invoke path.
    func invokeComputerWithReceiptForTesting(
        requestId: String,
        paramsJSON: String,
        idempotencyKey: String,
        receiptScope: String,
        timeoutMs: Int = 0,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async
        -> BridgeInvokeResponse
    {
        let payload = NodeInvokeRequestPayload(
            id: requestId,
            nodeId: "test-node",
            command: "computer.act",
            paramsJSON: paramsJSON,
            timeoutMs: timeoutMs,
            idempotencyKey: idempotencyKey)
        return await self.invokeWithComputerReceipt(
            requestPayload: payload,
            request: BridgeInvokeRequest(
                id: requestId,
                command: "computer.act",
                paramsJSON: paramsJSON,
                nodeId: "test-node"),
            timeoutMs: timeoutMs,
            receiptScope: receiptScope,
            onInvoke: onInvoke)
    }

    // periphery:ignore - package tests exercise retry after expiry before native dispatch.
    func invokeComputerWithExpiredReceiptForTesting(
        requestId: String,
        paramsJSON: String,
        idempotencyKey: String,
        receiptScope: String,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse) async
        -> BridgeInvokeResponse
    {
        let payload = NodeInvokeRequestPayload(
            id: requestId,
            nodeId: "test-node",
            command: "computer.act",
            paramsJSON: paramsJSON,
            timeoutMs: 1,
            idempotencyKey: idempotencyKey)
        return await self.invokeWithComputerReceipt(
            requestPayload: payload,
            request: BridgeInvokeRequest(
                id: requestId,
                command: "computer.act",
                paramsJSON: paramsJSON,
                nodeId: "test-node"),
            deadline: ContinuousClock.now.advanced(by: .milliseconds(-1)),
            receiptScope: receiptScope,
            onInvoke: onInvoke,
            retryStaleJoinedReceipt: true)
    }

    // periphery:ignore - package tests assert receipt joining without exposing the receipt store.
    func computerReceiptJoinCountForTesting(
        idempotencyKey: String,
        receiptScope: String) -> Int
    {
        let receiptKey = ComputerInvokeReceiptKey(
            receiptScope: receiptScope,
            idempotencyKey: idempotencyKey)
        guard let receiptID = self.computerInvokeReceipts[receiptKey]?.id else { return 0 }
        return self.computerInvokeReceiptJoinCounts[receiptID] ?? 0
    }
    #endif

    private static func computerInvokeFingerprint(_ request: NodeInvokeRequestPayload) -> String {
        // Negotiation may turn an omitted legacy envelope into an explicit null.
        // Both mean unattributed; only a non-empty session key changes ownership.
        let sessionEnvelope = request.sessionKey.flatMap {
            $0.isEmpty ? nil : "attributed:" + $0
        } ?? "unattributed"
        let value = [
            request.nodeId,
            request.command,
            request.paramsJSON ?? "",
            sessionEnvelope,
        ].joined(separator: "\u{0}")
        return SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func rebindInvokeResponse(
        _ response: BridgeInvokeResponse,
        requestId: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            type: response.type,
            id: requestId,
            ok: response.ok,
            payload: response.payload,
            payloadJSON: response.payloadJSON,
            error: response.error)
    }

    private static func isStaleRouteInvokeResponse(_ response: BridgeInvokeResponse) -> Bool {
        response.ok == false &&
            response.error?.code == .unavailable &&
            response.error?.message == self.staleRouteInvokeMessage
    }

    private func discardRetryableComputerInvokeReceipt(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String,
        response: BridgeInvokeResponse)
    {
        guard Self.isStaleRouteInvokeResponse(response),
              self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.discardComputerInvokeReceipt(
            key: key,
            receiptID: receiptID,
            fingerprint: fingerprint)
    }

    private func discardComputerInvokeReceipt(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String)
    {
        guard self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.computerInvokeReceipts.removeValue(forKey: key)
        self.computerInvokeReceiptOrder.removeAll { $0 == key }
        #if DEBUG
        self.computerInvokeReceiptJoinCounts.removeValue(forKey: receiptID)
        #endif
    }

    private func markComputerInvokeOperationStarted(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String)
    {
        guard self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.computerInvokeReceipts[key]?.operationStarted = true
    }

    private func markComputerInvokeOperationSettled(
        key: ComputerInvokeReceiptKey,
        receiptID: UUID,
        fingerprint: String)
    {
        guard self.computerInvokeReceipts[key]?.id == receiptID,
              self.computerInvokeReceipts[key]?.fingerprint == fingerprint
        else { return }
        self.computerInvokeReceipts[key]?.operationSettled = true
    }

    private func makeComputerInvokeReceiptCapacity() -> Bool {
        while self.computerInvokeReceipts.count >= Self.computerInvokeReceiptLimit {
            guard let completedIndex = computerInvokeReceiptOrder.firstIndex(where: { key in
                guard let receipt = self.computerInvokeReceipts[key] else { return false }
                return receipt.state.isCompleted && receipt.operationSettled
            }) else { return false }
            let evictedKey = self.computerInvokeReceiptOrder.remove(at: completedIndex)
            let evictedReceipt = self.computerInvokeReceipts.removeValue(forKey: evictedKey)
            #if DEBUG
            if let receiptID = evictedReceipt?.id {
                self.computerInvokeReceiptJoinCounts.removeValue(forKey: receiptID)
            }
            #endif
        }
        return true
    }
}
