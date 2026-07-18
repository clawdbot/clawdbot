public struct OpenClawChatAudioInputDevice: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct OpenClawChatTalkControl {
    public var isEnabled: Bool
    public var isListening: Bool
    public var isSpeaking: Bool
    public var isGatewayConnected: Bool
    public var statusText: String
    public var providerLabel: String
    public var level: Double
    public var partialTranscript: String
    public var recentTranscript: [String]
    public var inputDevices: [OpenClawChatAudioInputDevice]
    public var selectedInputDeviceID: String?
    public var selectInputDevice: (@MainActor (_ deviceID: String?) -> Void)?
    public var toggle: @MainActor (_ sessionKey: String) -> Void

    public init(
        isEnabled: Bool,
        isListening: Bool,
        isSpeaking: Bool,
        isGatewayConnected: Bool,
        statusText: String,
        providerLabel: String,
        level: Double = 0,
        partialTranscript: String = "",
        recentTranscript: [String] = [],
        inputDevices: [OpenClawChatAudioInputDevice] = [],
        selectedInputDeviceID: String? = nil,
        selectInputDevice: (@MainActor (_ deviceID: String?) -> Void)? = nil,
        toggle: @escaping @MainActor (_ sessionKey: String) -> Void)
    {
        self.isEnabled = isEnabled
        self.isListening = isListening
        self.isSpeaking = isSpeaking
        self.isGatewayConnected = isGatewayConnected
        self.statusText = statusText
        self.providerLabel = providerLabel
        self.level = level
        self.partialTranscript = partialTranscript
        self.recentTranscript = recentTranscript
        self.inputDevices = inputDevices
        self.selectedInputDeviceID = selectedInputDeviceID
        self.selectInputDevice = selectInputDevice
        self.toggle = toggle
    }
}
