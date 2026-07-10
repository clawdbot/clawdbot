public struct OpenClawChatTalkControl {
    public var isEnabled: Bool
    public var isListening: Bool
    public var isSpeaking: Bool
    public var isGatewayConnected: Bool
    public var statusText: String
    public var providerLabel: String
    public var toggle: @MainActor (_ sessionKey: String) -> Void

    public init(
        isEnabled: Bool,
        isListening: Bool,
        isSpeaking: Bool,
        isGatewayConnected: Bool,
        statusText: String,
        providerLabel: String,
        toggle: @escaping @MainActor (_ sessionKey: String) -> Void)
    {
        self.isEnabled = isEnabled
        self.isListening = isListening
        self.isSpeaking = isSpeaking
        self.isGatewayConnected = isGatewayConnected
        self.statusText = statusText
        self.providerLabel = providerLabel
        self.toggle = toggle
    }
}
