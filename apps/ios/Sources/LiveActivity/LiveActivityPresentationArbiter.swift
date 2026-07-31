import Foundation

struct LiveActivityPresentationRequest: Equatable {
    var state: OpenClawActivityAttributes.ContentState
    var staleDate: Date?
    var agentName: String
    var sessionKey: String
}

struct LiveActivityVoiceSampleBuffer {
    private(set) var values: [UInt8] = []
    let capacity: Int

    init(capacity: Int = 24) {
        self.capacity = max(capacity, 1)
    }

    var payload: [UInt8]? {
        self.values.isEmpty ? nil : self.values
    }

    static func quantize(_ level: Double?) -> UInt8? {
        guard let level, level.isFinite else { return nil }
        let clamped = min(max(level, 0), 1)
        return UInt8((clamped * 255).rounded())
    }

    mutating func append(_ sample: UInt8) {
        self.values.append(sample)
        if self.values.count > self.capacity {
            self.values.removeFirst(self.values.count - self.capacity)
        }
    }

    mutating func reset() {
        self.values.removeAll(keepingCapacity: true)
    }
}

/// Keeps independent producers from overwriting higher-priority Live Activity
/// state. ActivityKit receives one reconciled presentation instead of competing
/// connection, tool, and voice writes.
struct LiveActivityPresentationArbiter {
    private struct ToolIdentity: Hashable {
        let sessionKey: String
        let id: String
    }

    private(set) var connection: LiveActivityPresentationRequest?
    private(set) var attention: LiveActivityPresentationRequest?
    private(set) var voice: LiveActivityPresentationRequest?
    private(set) var hydratedToolFallback: LiveActivityPresentationRequest?
    private var toolsByIdentity: [ToolIdentity: LiveActivityPresentationRequest] = [:]
    private var toolOrder: [ToolIdentity] = []

    var current: LiveActivityPresentationRequest? {
        if let attention {
            return attention
        }
        if let toolIdentity = toolOrder.last,
           let tool = toolsByIdentity[toolIdentity]
        {
            return tool
        }
        return self.voice ?? self.connection ?? self.hydratedToolFallback
    }

    var activeToolCount: Int {
        self.toolsByIdentity.count
    }

    static func voiceStatus(
        isListening: Bool,
        isSpeaking: Bool) -> OpenClawActivityAttributes.ContentState.Status
    {
        if isSpeaking {
            return .voiceSpeaking
        }
        if isListening {
            return .voiceListening
        }
        return .voiceActive
    }

    mutating func setConnection(_ request: LiveActivityPresentationRequest?) {
        if request != nil {
            self.hydratedToolFallback = nil
        }
        self.connection = request
    }

    mutating func setAttention(_ request: LiveActivityPresentationRequest?) {
        self.attention = request
    }

    mutating func setVoice(_ request: LiveActivityPresentationRequest?) {
        if request != nil {
            self.hydratedToolFallback = nil
        }
        self.voice = request
    }

    /// Called only by synchronous process-start hydration before the manager
    /// escapes its initializer. Live producers consume this one-time fallback.
    mutating func adoptInitialHydratedToolFallback(_ request: LiveActivityPresentationRequest?) {
        self.hydratedToolFallback = request
    }

    mutating func refreshVoice(staleDate: Date) {
        self.voice?.staleDate = staleDate
    }

    mutating func startTool(id: String, request: LiveActivityPresentationRequest) {
        guard !id.isEmpty else { return }
        self.hydratedToolFallback = nil
        let identity = ToolIdentity(sessionKey: request.sessionKey, id: id)
        if self.toolsByIdentity[identity] == nil {
            self.toolOrder.append(identity)
        }
        self.toolsByIdentity[identity] = request
    }

    mutating func endTool(id: String, sessionKey: String) {
        self.hydratedToolFallback = nil
        let identity = ToolIdentity(sessionKey: sessionKey, id: id)
        self.toolsByIdentity[identity] = nil
        self.toolOrder.removeAll { $0 == identity }
    }

    mutating func refreshTools(staleDate: Date) {
        for identity in self.toolsByIdentity.keys {
            self.toolsByIdentity[identity]?.staleDate = staleDate
        }
    }

    mutating func clearConnectionState() {
        self.connection = nil
        self.attention = nil
        self.hydratedToolFallback = nil
    }

    mutating func clearAll() {
        self.connection = nil
        self.attention = nil
        self.voice = nil
        self.hydratedToolFallback = nil
        self.toolsByIdentity.removeAll(keepingCapacity: true)
        self.toolOrder.removeAll(keepingCapacity: true)
    }
}
