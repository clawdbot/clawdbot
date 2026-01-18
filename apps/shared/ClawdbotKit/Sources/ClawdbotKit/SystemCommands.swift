import Foundation

public enum ClawdbotSystemCommand: String, Codable, Sendable {
    case run = "system.run"
    case which = "system.which"
    case notify = "system.notify"
}

public enum ClawdbotNotificationPriority: String, Codable, Sendable {
    case passive
    case active
    case timeSensitive
}

public enum ClawdbotNotificationDelivery: String, Codable, Sendable {
    case system
    case overlay
    case auto
}

public struct ClawdbotSystemRunParams: Codable, Sendable, Equatable {
    public var command: [String]
    public var rawCommand: String?
    public var cwd: String?
    public var env: [String: String]?
    public var timeoutMs: Int?
    public var needsScreenRecording: Bool?
    public var agentId: String?
    public var sessionKey: String?

    public init(
        command: [String],
        rawCommand: String? = nil,
        cwd: String? = nil,
        env: [String: String]? = nil,
        timeoutMs: Int? = nil,
        needsScreenRecording: Bool? = nil,
        agentId: String? = nil,
        sessionKey: String? = nil)
    {
        self.command = command
        self.rawCommand = rawCommand
        self.cwd = cwd
        self.env = env
        self.timeoutMs = timeoutMs
        self.needsScreenRecording = needsScreenRecording
        self.agentId = agentId
        self.sessionKey = sessionKey
    }
}

public struct ClawdbotSystemWhichParams: Codable, Sendable, Equatable {
    public var bins: [String]

    public init(bins: [String]) {
        self.bins = bins
    }
}

public struct ClawdbotSystemNotifyParams: Codable, Sendable, Equatable {
    public var title: String
    public var body: String
    public var sound: String?
    public var priority: ClawdbotNotificationPriority?
    public var delivery: ClawdbotNotificationDelivery?

    public init(
        title: String,
        body: String,
        sound: String? = nil,
        priority: ClawdbotNotificationPriority? = nil,
        delivery: ClawdbotNotificationDelivery? = nil)
    {
        self.title = title
        self.body = body
        self.sound = sound
        self.priority = priority
        self.delivery = delivery
    }
}
