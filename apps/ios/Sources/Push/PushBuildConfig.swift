import Foundation

enum PushTransportMode: String {
    case direct
    case relay
}

enum PushDistributionMode: String {
    case local
    case official
}

enum PushAPNsEnvironment: String {
    case sandbox
    case production
}

enum PushRelayProfile: String {
    case production
    case deviceSandbox
    case simulatorSandbox
}

enum PushProofPolicy: String {
    case appleStrict
    case appleDevelopment
    case internalSimulator
}

enum PushBuildMode: String {
    case localSandbox
    case localProduction
    case appStore
    case deviceSandbox
    case simulatorSandbox
}

struct PushBuildConfig {
    let mode: PushBuildMode
    let transport: PushTransportMode
    let distribution: PushDistributionMode
    let relayBaseURL: URL?
    let apnsEnvironment: PushAPNsEnvironment
    let relayProfile: PushRelayProfile
    let proofPolicy: PushProofPolicy

    static let current = PushBuildConfig()
    static let openClawHostedRelayHost = "ios-push-relay.openclaw.ai"
    static let openClawSandboxRelayHost = "ios-push-relay-sandbox.openclaw.ai"

    var usesOpenClawHostedRelay: Bool {
        guard self.transport == .relay, self.distribution == .official else { return false }
        guard let relayBaseURL = self.relayBaseURL,
              let components = URLComponents(url: relayBaseURL, resolvingAgainstBaseURL: false)
        else {
            return false
        }
        return components.scheme?.lowercased() == "https"
            && [Self.openClawHostedRelayHost, Self.openClawSandboxRelayHost]
            .contains(components.host?.lowercased() ?? "")
            && components.user == nil
            && components.password == nil
    }

    init(bundle: Bundle = .main) {
        self.init(readValue: { bundle.object(forInfoDictionaryKey: $0) })
    }

    init(infoDictionary: [String: Any]) {
        self.init(readValue: { infoDictionary[$0] })
    }

    private init(readValue: (String) -> Any?) {
        self.mode = Self.readEnum(
            readValue: readValue,
            key: "OpenClawPushMode",
            fallback: .localSandbox)
        let relayBaseURLOverride = Self.readURL(
            readValue: readValue,
            key: "OpenClawPushRelayBaseURL")
        switch self.mode {
        case .localSandbox:
            self.transport = .direct
            self.distribution = .local
            self.relayBaseURL = nil
            self.apnsEnvironment = .sandbox
            self.relayProfile = .deviceSandbox
            self.proofPolicy = .appleDevelopment
        case .localProduction:
            self.transport = .direct
            self.distribution = .local
            self.relayBaseURL = nil
            self.apnsEnvironment = .production
            self.relayProfile = .production
            self.proofPolicy = .appleStrict
        case .appStore:
            self.transport = .relay
            self.distribution = .official
            self.relayBaseURL = URL(string: "https://\(Self.openClawHostedRelayHost)")!
            self.apnsEnvironment = .production
            self.relayProfile = .production
            self.proofPolicy = .appleStrict
        case .deviceSandbox:
            self.transport = .relay
            self.distribution = .official
            self.relayBaseURL = relayBaseURLOverride
                ?? URL(string: "https://\(Self.openClawSandboxRelayHost)")!
            self.apnsEnvironment = .sandbox
            self.relayProfile = .deviceSandbox
            self.proofPolicy = .appleDevelopment
        case .simulatorSandbox:
            self.transport = .relay
            self.distribution = .official
            self.relayBaseURL = relayBaseURLOverride
                ?? URL(string: "https://\(Self.openClawSandboxRelayHost)")!
            self.apnsEnvironment = .sandbox
            self.relayProfile = .simulatorSandbox
            self.proofPolicy = .internalSimulator
        }
    }

    private static func readURL(readValue: (String) -> Any?, key: String) -> URL? {
        guard let raw = readValue(key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            return nil
        }
        return components.url
    }

    private static func readEnum<T: RawRepresentable>(
        readValue: (String) -> Any?,
        key: String,
        fallback: T)
    -> T where T.RawValue == String {
        guard let raw = readValue(key) as? String else { return fallback }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return T(rawValue: trimmed) ?? T(rawValue: trimmed.lowercased()) ?? fallback
    }
}
