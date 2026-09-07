import Foundation

public struct MacControlRequest: Codable, Sendable {
    public var operation: String
    public var mode: String?
    public var transport: String?
    public var sshTarget: String?
    public var remotePort: Int?
    public var localPort: Int?
    public var identityPath: String?
    public var hostKeyPolicy: String?
    public var url: String?
    public var token: String?
    public var password: String?
    public var tlsFingerprint: String?
    public var name: String?
    public var browser: Bool?
    public var idOrName: String?
    public var deadline: Date?

    public init(operation: String) {
        self.operation = operation
    }
}

public struct MacControlConnectionStatus: Codable, Sendable {
    public var state: String
    public var gatewayVersion: String?
    public var error: String?

    public init(state: String, gatewayVersion: String? = nil, error: String? = nil) {
        self.state = state
        self.gatewayVersion = gatewayVersion
        self.error = error
    }
}

public struct MacControlTunnelStatus: Codable, Sendable {
    public var running: Bool
    public var localPort: Int?

    public init(running: Bool, localPort: Int? = nil) {
        self.running = running
        self.localPort = localPort
    }
}

public struct MacControlPrimaryStatus: Codable, Sendable {
    public var mode: String
    public var transport: String?
    public var sshTarget: String?
    public var url: String
    public var remotePort: Int?
    public var tunnel: MacControlTunnelStatus
    public var connection: MacControlConnectionStatus

    public init(
        mode: String,
        transport: String?,
        sshTarget: String? = nil,
        url: String,
        remotePort: Int? = nil,
        tunnel: MacControlTunnelStatus,
        connection: MacControlConnectionStatus)
    {
        self.mode = mode
        self.transport = transport
        self.sshTarget = sshTarget
        self.url = url
        self.remotePort = remotePort
        self.tunnel = tunnel
        self.connection = connection
    }

    private enum CodingKeys: String, CodingKey {
        case mode, transport, sshTarget, url, remotePort, tunnel, connection
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.mode, forKey: .mode)
        try container.encode(self.transport, forKey: .transport)
        try container.encodeIfPresent(self.sshTarget, forKey: .sshTarget)
        try container.encode(self.url, forKey: .url)
        try container.encodeIfPresent(self.remotePort, forKey: .remotePort)
        try container.encode(self.tunnel, forKey: .tunnel)
        try container.encode(self.connection, forKey: .connection)
    }
}

public struct MacControlIdentity: Codable, Sendable {
    public var provider: String
    public var subject: String
    public var expiresAt: String

    public init(provider: String = "cloudflareAccess", subject: String, expiresAt: String) {
        self.provider = provider
        self.subject = subject
        self.expiresAt = expiresAt
    }
}

public struct MacControlGatewayStatus: Codable, Sendable {
    public var id: String
    public var name: String
    public var url: String
    public var auth: String
    public var identity: MacControlIdentity?
    public var connection: MacControlConnectionStatus

    public init(
        id: String,
        name: String,
        url: String,
        auth: String,
        identity: MacControlIdentity? = nil,
        connection: MacControlConnectionStatus)
    {
        self.id = id
        self.name = name
        self.url = url
        self.auth = auth
        self.identity = identity
        self.connection = connection
    }
}

public struct MacControlAppStatus: Codable, Sendable {
    public var version: String
    public var build: String
    public var profile: String

    public init(version: String, build: String, profile: String) {
        self.version = version
        self.build = build
        self.profile = profile
    }
}

public struct MacControlStatus: Codable, Sendable {
    public var primary: MacControlPrimaryStatus
    public var gateways: [MacControlGatewayStatus]
    public var app: MacControlAppStatus

    public init(primary: MacControlPrimaryStatus, gateways: [MacControlGatewayStatus], app: MacControlAppStatus) {
        self.primary = primary
        self.gateways = gateways
        self.app = app
    }
}

public struct MacControlError: Codable, LocalizedError, Sendable {
    public var code: String
    public var message: String
    public var errorDescription: String? {
        self.message
    }

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct MacControlResponse<Result: Codable & Sendable>: Codable, Sendable {
    public var ok: Bool
    public var result: Result?
    public var error: MacControlError?

    public init(result: Result) {
        self.ok = true
        self.result = result
    }

    public init(error: MacControlError) {
        self.ok = false
        self.error = error
    }
}
