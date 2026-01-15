import Foundation

public struct BridgeBaseFrame: Codable, Sendable {
    public let type: String

    public init(type: String) {
        self.type = type
    }
}

public struct BridgeInvokeRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let command: String
    public let paramsJSON: String?

    public init(type: String = "invoke", id: String, command: String, paramsJSON: String? = nil) {
        self.type = type
        self.id = id
        self.command = command
        self.paramsJSON = paramsJSON
    }
}

public struct BridgeInvokeResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let payloadJSON: String?
    public let error: ClawdbotNodeError?

    public init(
        type: String = "invoke-res",
        id: String,
        ok: Bool,
        payloadJSON: String? = nil,
        error: ClawdbotNodeError? = nil)
    {
        self.type = type
        self.id = id
        self.ok = ok
        self.payloadJSON = payloadJSON
        self.error = error
    }
}

public struct BridgeEventFrame: Codable, Sendable {
    public let type: String
    public let event: String
    public let payloadJSON: String?

    public init(type: String = "event", event: String, payloadJSON: String? = nil) {
        self.type = type
        self.event = event
        self.payloadJSON = payloadJSON
    }
}

public struct BridgeHello: Codable, Sendable {
    public let type: String
    public let nodeId: String
    public let displayName: String?
    public let token: String?
    public let platform: String?
    public let version: String?
    public let deviceFamily: String?
    public let modelIdentifier: String?
    public let caps: [String]?
    public let commands: [String]?
    public let permissions: [String: Bool]?

    public init(
        type: String = "hello",
        nodeId: String,
        displayName: String?,
        token: String?,
        platform: String?,
        version: String?,
        deviceFamily: String? = nil,
        modelIdentifier: String? = nil,
        caps: [String]? = nil,
        commands: [String]? = nil,
        permissions: [String: Bool]? = nil)
    {
        self.type = type
        self.nodeId = nodeId
        self.displayName = displayName
        self.token = token
        self.platform = platform
        self.version = version
        self.deviceFamily = deviceFamily
        self.modelIdentifier = modelIdentifier
        self.caps = caps
        self.commands = commands
        self.permissions = permissions
    }
}

public struct BridgeHelloOk: Codable, Sendable {
    public let type: String
    public let serverName: String
    public let canvasHostUrl: String?
    public let mainSessionKey: String?

    public init(
        type: String = "hello-ok",
        serverName: String,
        canvasHostUrl: String? = nil,
        mainSessionKey: String? = nil)
    {
        self.type = type
        self.serverName = serverName
        self.canvasHostUrl = canvasHostUrl
        self.mainSessionKey = mainSessionKey
    }
}

public struct BridgePairRequest: Codable, Sendable {
    public let type: String
    public let nodeId: String
    public let displayName: String?
    public let platform: String?
    public let version: String?
    public let deviceFamily: String?
    public let modelIdentifier: String?
    public let caps: [String]?
    public let commands: [String]?
    public let permissions: [String: Bool]?
    public let remoteAddress: String?
    public let silent: Bool?

    public init(
        type: String = "pair-request",
        nodeId: String,
        displayName: String?,
        platform: String?,
        version: String?,
        deviceFamily: String? = nil,
        modelIdentifier: String? = nil,
        caps: [String]? = nil,
        commands: [String]? = nil,
        permissions: [String: Bool]? = nil,
        remoteAddress: String? = nil,
        silent: Bool? = nil)
    {
        self.type = type
        self.nodeId = nodeId
        self.displayName = displayName
        self.platform = platform
        self.version = version
        self.deviceFamily = deviceFamily
        self.modelIdentifier = modelIdentifier
        self.caps = caps
        self.commands = commands
        self.permissions = permissions
        self.remoteAddress = remoteAddress
        self.silent = silent
    }
}

public struct BridgePairOk: Codable, Sendable {
    public let type: String
    public let token: String

    public init(type: String = "pair-ok", token: String) {
        self.type = type
        self.token = token
    }
}

public struct BridgePing: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String = "ping", id: String) {
        self.type = type
        self.id = id
    }
}

public struct BridgePong: Codable, Sendable {
    public let type: String
    public let id: String

    public init(type: String = "pong", id: String) {
        self.type = type
        self.id = id
    }
}

public struct BridgeErrorFrame: Codable, Sendable {
    public let type: String
    public let code: String
    public let message: String

    public init(type: String = "error", code: String, message: String) {
        self.type = type
        self.code = code
        self.message = message
    }
}

// MARK: - Optional RPC (node -> bridge)

public struct BridgeRPCRequest: Codable, Sendable {
    public let type: String
    public let id: String
    public let method: String
    public let paramsJSON: String?

    public init(type: String = "req", id: String, method: String, paramsJSON: String? = nil) {
        self.type = type
        self.id = id
        self.method = method
        self.paramsJSON = paramsJSON
    }
}

public struct BridgeRPCError: Codable, Sendable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct BridgeRPCResponse: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let payloadJSON: String?
    public let error: BridgeRPCError?

    public init(
        type: String = "res",
        id: String,
        ok: Bool,
        payloadJSON: String? = nil,
        error: BridgeRPCError? = nil)
    {
        self.type = type
        self.id = id
        self.ok = ok
        self.payloadJSON = payloadJSON
        self.error = error
    }
}
