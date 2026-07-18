public enum OpenClawGatewayClientCapability {
    public static let inlineWidgets = "inline-widgets"
}

public struct GatewayConnectOptions: Sendable {
    public var role: String
    public var scopes: [String]
    public var scopesAreExplicit: Bool
    public var caps: [String]
    public var commands: [String]
    public var pathEnv: String?
    public var permissions: [String: Bool]
    public var clientId: String
    public var clientMode: String
    public var clientDisplayName: String?
    public var deviceIdentityProfile: GatewayDeviceIdentityProfile
    /// When false, the connection omits the signed device identity payload and cannot use
    /// device-scoped auth (role/scope upgrades will require pairing). Keep this true for
    /// role/scoped sessions such as operator UI clients.
    public var includeDeviceIdentity: Bool
    /// Set false for an endpoint handoff whose explicit credentials (including none) must be
    /// tried without reusing a device token issued by a different gateway.
    public var allowStoredDeviceAuth: Bool
    /// Stable gateway owner for device tokens. Nil preserves legacy unscoped storage for clients
    /// that have not adopted endpoint ownership yet.
    public var deviceAuthGatewayID: String?

    public init(
        role: String,
        scopes: [String],
        scopesAreExplicit: Bool = false,
        caps: [String],
        commands: [String],
        pathEnv: String? = nil,
        permissions: [String: Bool],
        clientId: String,
        clientMode: String,
        clientDisplayName: String?,
        deviceIdentityProfile: GatewayDeviceIdentityProfile = .primary,
        includeDeviceIdentity: Bool = true,
        allowStoredDeviceAuth: Bool = true,
        deviceAuthGatewayID: String? = nil)
    {
        self.role = role
        self.scopes = scopes
        self.scopesAreExplicit = scopesAreExplicit
        self.caps = caps
        self.commands = commands
        self.pathEnv = pathEnv
        self.permissions = permissions
        self.clientId = clientId
        self.clientMode = clientMode
        self.clientDisplayName = clientDisplayName
        self.deviceIdentityProfile = deviceIdentityProfile
        self.includeDeviceIdentity = includeDeviceIdentity
        self.allowStoredDeviceAuth = allowStoredDeviceAuth
        self.deviceAuthGatewayID = deviceAuthGatewayID
    }
}

public enum GatewayAuthSource: String, Sendable {
    case deviceToken = "device-token"
    case sharedToken = "shared-token"
    case bootstrapToken = "bootstrap-token"
    case password
    case none
}

/// Opaque binding for the exact credentials selected by one live Gateway socket.
/// The credential itself never leaves `GatewayChannelActor`.
public struct GatewayAuthBinding: Equatable, Sendable {
    public let source: GatewayAuthSource
    public let credentialFingerprint: String?
}
