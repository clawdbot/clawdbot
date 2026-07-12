import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import UserNotifications
import WatchKit

@MainActor @Observable
final class WatchDirectNode {
    private struct PersistedConfiguration: Codable {
        var link: GatewayConnectDeepLink
        var gatewayID: String
        var setupSentAtMs: Int64?
    }

    private struct ActiveSession: Equatable {
        let baseURL: URL
        let token: String
    }

    private struct ConnectResponse: Decodable {
        let sessionToken: String
        let deviceToken: String
    }

    private enum ConnectCredential {
        case bootstrap(String)
        case device(String)

        var token: String {
            switch self {
            case let .bootstrap(token), let .device(token): token
            }
        }
    }

    private struct ChallengeResponse: Decodable {
        let nonce: String
    }

    private struct PollResponse: Decodable {
        let event: NodeEvent?
    }

    private struct NodeEvent: Decodable {
        let event: String
        let payload: InvokeRequest?
    }

    private struct InvokeRequest: Decodable {
        let id: String
        let nodeId: String
        let command: String
        let paramsJSON: String?
    }

    private struct HTTPError: LocalizedError {
        let status: Int
        let detail: String

        var errorDescription: String? {
            self.detail.isEmpty
                ? String(
                    format: String(localized: "Gateway HTTP error (%@)"),
                    self.status.formatted())
                : self.detail
        }
    }

    private static let keychainService = "ai.openclaw.watch.direct-node"
    private static let keychainAccount = "gateway"
    private static let enabledDefaultsKey = "watch.directNode.enabled"
    private static let lastSetupSentAtDefaultsKey = "watch.directNode.lastSetupSentAtMs"
    private static let maximumSetupAgeMs: Int64 = 12 * 60 * 1000
    private static let maximumSetupClockSkewMs: Int64 = 2 * 60 * 1000
    private static let commands = [
        OpenClawDeviceCommand.info.rawValue,
        OpenClawDeviceCommand.status.rawValue,
        OpenClawSystemCommand.notify.rawValue,
    ]

    private let networkMetrics: WatchURLSessionMetrics
    private let urlSession: URLSession
    private var configuration: PersistedConfiguration?
    private var connectTask: Task<Void, Never>?
    private var activeSession: ActiveSession?
    private var isForeground = false
    private var connectionGeneration = 0

    private(set) var isEnabled: Bool
    private(set) var isConnected = false
    private(set) var statusText = String(
        localized: "Use iPhone Settings to enable direct connection.")
    private(set) var endpointText: String?

    var isConfigured: Bool {
        self.configuration != nil
    }

    init() {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.waitsForConnectivity = true
        sessionConfiguration.timeoutIntervalForRequest = 30
        sessionConfiguration.timeoutIntervalForResource = 35
        let networkMetrics = WatchURLSessionMetrics()
        self.networkMetrics = networkMetrics
        self.urlSession = URLSession(
            configuration: sessionConfiguration,
            delegate: networkMetrics,
            delegateQueue: nil)
        self.isEnabled = UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey)
        self.configuration = Self.loadConfiguration()
        if let setupSentAtMs = configuration?.setupSentAtMs,
           setupSentAtMs > Self.lastAcceptedSetupSentAtMs()
        {
            Self.saveLastAcceptedSetupSentAtMs(setupSentAtMs)
        }
        self.endpointText = self.configuration.map(Self.endpointText)
        if self.configuration != nil {
            self.statusText = self.isEnabled
                ? String(localized: "Ready to connect")
                : String(localized: "Direct connection is off")
        }
    }

    func configure(setupCode: String, sentAtMs: Int64) {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let oldestAcceptedMs = nowMs - Self.maximumSetupAgeMs
        let newestAcceptedMs = nowMs + Self.maximumSetupClockSkewMs
        guard (oldestAcceptedMs...newestAcceptedMs).contains(sentAtMs) else {
            self.statusText = String(
                localized: "Ignored an expired direct connection setup. Send setup again from iPhone.")
            return
        }
        let newestInstalledSetupMs = configuration?.setupSentAtMs ?? 0
        guard sentAtMs > max(Self.lastAcceptedSetupSentAtMs(), newestInstalledSetupMs) else { return }
        guard let link = GatewayConnectDeepLink.fromSetupCode(setupCode),
              link.isValidEndpoint,
              link.bootstrapToken != nil,
              link.token == nil,
              link.password == nil,
              let secureEndpoint = link.connectionEndpoints.first(where: \.tls)
        else {
            self.statusText = String(
                localized: "Direct mode requires a trusted HTTPS Gateway endpoint.")
            return
        }
        let secureEndpoints = link.connectionEndpoints.filter(\.tls)
        let secureLink = GatewayConnectDeepLink(
            host: secureEndpoint.host,
            port: secureEndpoint.port,
            tls: true,
            bootstrapToken: link.bootstrapToken,
            token: nil,
            password: nil,
            fallbackEndpoints: Array(secureEndpoints.dropFirst()))
        let previousConfiguration = self.configuration
        let configuration = PersistedConfiguration(
            link: secureLink,
            gatewayID: Self.gatewayID(for: secureLink),
            setupSentAtMs: sentAtMs)
        guard Self.saveConfiguration(configuration) else {
            self.statusText = String(localized: "Could not save direct connection securely.")
            return
        }
        if let previousConfiguration,
           previousConfiguration.gatewayID != configuration.gatewayID,
           let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary)
        {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "node",
                gatewayID: previousConfiguration.gatewayID,
                profile: .primary)
        }
        Self.saveLastAcceptedSetupSentAtMs(sentAtMs)
        self.disconnectActiveSession()
        self.configuration = configuration
        self.endpointText = Self.endpointText(configuration)
        self.statusText = String(localized: "Setup received. Connecting…")
        self.setEnabled(true)
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.enabledDefaultsKey)
        if enabled {
            self.connect()
        } else {
            self.disconnectActiveSession()
            self.connectionGeneration &+= 1
            self.connectTask?.cancel()
            self.connectTask = nil
            self.isConnected = false
            self.statusText = self.isConfigured
                ? String(localized: "Direct connection is off")
                : String(localized: "Use iPhone Settings to enable direct connection.")
        }
    }

    func connect() {
        guard self.isForeground, self.isEnabled, let configuration else { return }
        self.disconnectActiveSession()
        self.connectTask?.cancel()
        self.connectionGeneration &+= 1
        let generation = self.connectionGeneration
        self.connectTask = Task { [weak self] in
            await self?.run(configuration, generation: generation)
        }
    }

    func connectForForeground() {
        self.isForeground = true
        self.connect()
    }

    func disconnectForBackground() {
        self.isForeground = false
        self.disconnectActiveSession()
        self.connectionGeneration &+= 1
        self.connectTask?.cancel()
        self.connectTask = nil
        self.isConnected = false
        if self.isEnabled, self.isConfigured {
            self.statusText = String(localized: "Reconnects when OpenClaw is active")
        }
    }

    func forget() {
        self.disconnectActiveSession()
        self.connectionGeneration &+= 1
        self.connectTask?.cancel()
        self.connectTask = nil
        if let configuration {
            if let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary) {
                DeviceAuthStore.clearToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    gatewayID: configuration.gatewayID,
                    profile: .primary)
            }
        }
        _ = GenericPasswordKeychainStore.delete(
            service: Self.keychainService,
            account: Self.keychainAccount)
        configuration = nil
        self.endpointText = nil
        self.isConnected = false
        self.setEnabled(false)
    }

    private func run(_ configuration: PersistedConfiguration, generation: Int) async {
        while self.isCurrentConnection(generation, configuration: configuration) {
            var lastError: Error?
            for endpoint in configuration.link.connectionEndpoints {
                guard self.isCurrentConnection(generation, configuration: configuration) else { return }
                let link = configuration.link.selectingEndpoint(endpoint)
                guard let baseURL = Self.httpBaseURL(for: link) else { continue }
                do {
                    try await self.connectAndPoll(
                        configuration: configuration,
                        link: link,
                        baseURL: baseURL,
                        generation: generation)
                    return
                } catch is CancellationError {
                    return
                } catch let error as URLError where error.code == .cancelled {
                    return
                } catch {
                    guard self.isCurrentConnection(generation, configuration: configuration) else { return }
                    lastError = error
                    self.isConnected = false
                }
            }
            guard self.isCurrentConnection(generation, configuration: configuration) else { return }
            self.statusText = lastError.map {
                String(
                    format: String(localized: "Direct connection failed: %@"),
                    $0.localizedDescription)
            } ?? String(localized: "No usable Gateway endpoint")
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                return
            }
        }
    }

    private func connectAndPoll(
        configuration: PersistedConfiguration,
        link: GatewayConnectDeepLink,
        baseURL: URL,
        generation: Int) async throws
    {
        try self.requireCurrentConnection(generation, configuration: configuration)
        self.statusText = String(localized: "Connecting directly…")
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary) else {
            throw HTTPError(
                status: 0,
                detail: String(localized: "Could not save the watch device identity"))
        }
        let storedToken = DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: configuration.gatewayID,
            profile: .primary)?.token
        guard storedToken != nil || link.bootstrapToken != nil else {
            throw HTTPError(status: 401, detail: String(localized: "No watch device credential"))
        }
        let response: ConnectResponse
        if let bootstrapToken = link.bootstrapToken {
            do {
                response = try await self.establishSession(
                    identity: identity,
                    baseURL: baseURL,
                    credential: .bootstrap(bootstrapToken))
            } catch let error as HTTPError where error.status == 401 {
                guard let storedToken else { throw error }
                response = try await self.establishSession(
                    identity: identity,
                    baseURL: baseURL,
                    credential: .device(storedToken))
            }
        } else if let storedToken {
            response = try await self.establishSession(
                identity: identity,
                baseURL: baseURL,
                credential: .device(storedToken))
        } else {
            throw HTTPError(status: 401, detail: String(localized: "No watch device credential"))
        }
        // A successful bootstrap response has already consumed the one-time code.
        // Finish that durable handoff across background/toggle cancellation, but
        // never let an obsolete attempt overwrite a forgotten or newer setup.
        do {
            guard self.isInstalledConfiguration(configuration) else { throw CancellationError() }
            guard DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "node",
                token: response.deviceToken,
                scopes: [],
                gatewayID: configuration.gatewayID,
                profile: .primary)
            else {
                throw HTTPError(
                    status: 0,
                    detail: String(localized: "Could not save the watch device credential"))
            }
            if link.bootstrapToken != nil {
                try self.finishCredentialHandoff(configuration: configuration)
            }
            try self.requireCurrentConnection(generation, configuration: configuration)
        } catch {
            self.sendDisconnect(ActiveSession(baseURL: baseURL, token: response.sessionToken))
            throw error
        }
        let session = ActiveSession(baseURL: baseURL, token: response.sessionToken)
        self.activeSession = session
        defer { releaseActiveSession(session) }
        self.isConnected = true
        self.statusText = String(localized: "Connected directly")
        while self.isCurrentConnection(generation, configuration: configuration) {
            let pollData = try await request(
                baseURL: baseURL,
                path: "poll",
                method: "POST",
                token: response.sessionToken)
            try self.requireCurrentConnection(generation, configuration: configuration)
            let poll = try JSONDecoder().decode(PollResponse.self, from: pollData)
            guard let event = poll.event else { continue }
            guard event.event == "node.invoke.request", let invoke = event.payload else { continue }
            let invokeRequest = BridgeInvokeRequest(
                id: invoke.id,
                command: invoke.command,
                paramsJSON: invoke.paramsJSON,
                nodeId: invoke.nodeId)
            let result = await handleInvoke(invokeRequest)
            try requireCurrentConnection(generation, configuration: configuration)
            _ = try await self.request(
                baseURL: baseURL,
                path: "result",
                method: "POST",
                token: response.sessionToken,
                body: result)
            try self.requireCurrentConnection(generation, configuration: configuration)
        }
    }

    private func isCurrentConnection(
        _ generation: Int,
        configuration: PersistedConfiguration) -> Bool
    {
        !Task.isCancelled
            && generation == self.connectionGeneration
            && self.isForeground
            && self.isEnabled
            && self.isInstalledConfiguration(configuration)
    }

    private func isInstalledConfiguration(_ configuration: PersistedConfiguration) -> Bool {
        configuration.gatewayID == self.configuration?.gatewayID
            && configuration.setupSentAtMs == self.configuration?.setupSentAtMs
    }

    private func requireCurrentConnection(
        _ generation: Int,
        configuration: PersistedConfiguration) throws
    {
        guard self.isCurrentConnection(generation, configuration: configuration) else {
            throw CancellationError()
        }
    }

    private func establishSession(
        identity: DeviceIdentity,
        baseURL: URL,
        credential: ConnectCredential) async throws -> ConnectResponse
    {
        let challengeData = try await request(
            baseURL: baseURL,
            path: "challenge",
            method: "GET",
            token: nil)
        let challenge = try JSONDecoder().decode(ChallengeResponse.self, from: challengeData)
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        let params = try connectParams(
            identity: identity,
            nonce: challenge.nonce,
            credential: credential,
            notificationsAuthorized: notificationSettings.authorizationStatus == .authorized
                || notificationSettings.authorizationStatus == .provisional)
        let connectData = try await request(
            baseURL: baseURL,
            path: "connect",
            method: "POST",
            token: nil,
            body: params)
        return try JSONDecoder().decode(ConnectResponse.self, from: connectData)
    }

    private func connectParams(
        identity: DeviceIdentity,
        nonce: String,
        credential: ConnectCredential,
        notificationsAuthorized: Bool) throws -> ConnectParams
    {
        let signedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let payload = GatewayDeviceAuthPayload.buildV3(
            fields: .init(
                deviceId: identity.deviceId,
                client: .init(id: "openclaw-watchos", mode: "node"),
                role: "node",
                scopes: [],
                signedAtMs: signedAtMs,
                token: credential.token,
                nonce: nonce),
            platform: InstanceIdentity.platformString,
            deviceFamily: InstanceIdentity.deviceFamily)
        guard let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
            payload: payload,
            identity: identity,
            signedAtMs: signedAtMs,
            nonce: nonce)
        else {
            throw HTTPError(status: 0, detail: String(localized: "Could not sign watch identity"))
        }
        var client: [String: AnyCodable] = [
            "id": AnyCodable("openclaw-watchos"),
            "displayName": AnyCodable(InstanceIdentity.displayName),
            "version": AnyCodable(
                Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"),
            "platform": AnyCodable(InstanceIdentity.platformString),
            "deviceFamily": AnyCodable(InstanceIdentity.deviceFamily),
            "mode": AnyCodable("node"),
            "instanceId": AnyCodable(InstanceIdentity.instanceId),
        ]
        if let modelIdentifier = InstanceIdentity.modelIdentifier {
            client["modelIdentifier"] = AnyCodable(modelIdentifier)
        }
        let auth: [String: AnyCodable] = switch credential {
        case let .device(token):
            ["deviceToken": AnyCodable(token)]
        case let .bootstrap(token):
            ["bootstrapToken": AnyCodable(token)]
        }
        return ConnectParams(
            minprotocol: GATEWAY_MIN_PROTOCOL_VERSION,
            maxprotocol: GATEWAY_PROTOCOL_VERSION,
            client: client,
            caps: [],
            commands: Self.commands,
            permissions: ["notifications": AnyCodable(notificationsAuthorized)],
            pathenv: nil,
            role: "node",
            scopes: [],
            device: device,
            auth: auth,
            locale: Locale.preferredLanguages.first ?? Locale.current.identifier,
            useragent: ProcessInfo.processInfo.operatingSystemVersionString)
    }

    private func request(
        baseURL: URL,
        path: String,
        method: String,
        token: String?) async throws -> Data
    {
        try await self.performRequest(
            baseURL: baseURL,
            path: path,
            method: method,
            token: token,
            body: nil)
    }

    private func request(
        baseURL: URL,
        path: String,
        method: String,
        token: String?,
        body: some Encodable) async throws -> Data
    {
        let encodedBody = try JSONEncoder().encode(body)
        return try await self.performRequest(
            baseURL: baseURL,
            path: path,
            method: method,
            token: token,
            body: encodedBody)
    }

    private func performRequest(
        baseURL: URL,
        path: String,
        method: String,
        token: String?,
        body: Data?) async throws -> Data
    {
        let url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("nodes")
            .appendingPathComponent("watch")
            .appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = path == "poll" ? 25 : 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HTTPError(status: 0, detail: String(localized: "Invalid Gateway response"))
        }
        guard (200..<300).contains(http.statusCode) else {
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw HTTPError(status: http.statusCode, detail: detail)
        }
        return data
    }

    private func finishCredentialHandoff(configuration: PersistedConfiguration) throws {
        let link = configuration.link
        let sanitized = PersistedConfiguration(
            link: GatewayConnectDeepLink(
                host: link.host,
                port: link.port,
                tls: link.tls,
                bootstrapToken: nil,
                token: nil,
                password: nil,
                fallbackEndpoints: link.fallbackEndpoints),
            gatewayID: configuration.gatewayID,
            setupSentAtMs: configuration.setupSentAtMs)
        guard Self.saveConfiguration(sanitized) else {
            throw HTTPError(
                status: 0,
                detail: String(localized: "Paired, but could not finish secure setup"))
        }
        self.configuration = sanitized
        self.endpointText = Self.endpointText(sanitized)
    }

    private func handleInvoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        do {
            switch request.command {
            case OpenClawDeviceCommand.info.rawValue:
                return try self.encodedResponse(id: request.id, payload: self.deviceInfo())
            case OpenClawDeviceCommand.status.rawValue:
                return try self.encodedResponse(id: request.id, payload: self.deviceStatus())
            case OpenClawSystemCommand.notify.rawValue:
                return try await self.handleNotification(request)
            default:
                return Self.errorResponse(
                    id: request.id,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: unsupported watchOS command")
            }
        } catch {
            return Self.errorResponse(
                id: request.id,
                code: .unavailable,
                message: error.localizedDescription)
        }
    }

    private func handleNotification(_ request: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decode(OpenClawSystemNotifyParams.self, from: request.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty || !body.isEmpty else {
            return Self.errorResponse(
                id: request.id,
                code: .invalidRequest,
                message: "INVALID_REQUEST: empty notification")
        }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            return Self.errorResponse(
                id: request.id,
                code: .unavailable,
                message: "NOT_AUTHORIZED: notifications")
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        switch params.priority ?? .active {
        case .passive:
            content.interruptionLevel = .passive
        case .timeSensitive:
            content.interruptionLevel = .timeSensitive
        case .active:
            content.interruptionLevel = .active
        }
        let sound = params.sound?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        content.sound = sound.map { ["none", "silent", "off"].contains($0) } == true ? nil : .default
        try await center.add(UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil))
        return BridgeInvokeResponse(id: request.id, ok: true)
    }

    private func deviceInfo() -> OpenClawDeviceInfoPayload {
        let device = WKInterfaceDevice.current()
        let info = Bundle.main.infoDictionary ?? [:]
        let appVersion = (info["CFBundleShortVersionString"] as? String) ?? "0"
        let appBuild = (info["CFBundleVersion"] as? String) ?? "0"
        return OpenClawDeviceInfoPayload(
            deviceName: device.name,
            modelIdentifier: InstanceIdentity.modelIdentifier ?? "Apple Watch",
            systemName: "watchOS",
            systemVersion: device.systemVersion,
            appVersion: appVersion,
            appBuild: appBuild,
            locale: Locale.preferredLanguages.first ?? Locale.current.identifier)
    }

    private func deviceStatus() -> OpenClawDeviceStatusPayload {
        let device = WKInterfaceDevice.current()
        device.isBatteryMonitoringEnabled = true
        let batteryState: OpenClawBatteryState = switch device.batteryState {
        case .charging: .charging
        case .full: .full
        case .unplugged: .unplugged
        case .unknown: .unknown
        @unknown default: .unknown
        }
        let battery = OpenClawBatteryStatusPayload(
            level: device.batteryLevel >= 0 ? Double(device.batteryLevel) : nil,
            state: batteryState,
            lowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled)
        let thermalState: OpenClawThermalState = switch ProcessInfo.processInfo.thermalState {
        case .nominal: .nominal
        case .fair: .fair
        case .serious: .serious
        case .critical: .critical
        @unknown default: .nominal
        }
        let attributes = (try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())) ?? [:]
        let total = (attributes[.systemSize] as? NSNumber)?.int64Value ?? 0
        let free = (attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let networkMetrics = self.networkMetrics.snapshot()
        return OpenClawDeviceStatusPayload(
            battery: battery,
            thermal: OpenClawThermalStatusPayload(state: thermalState),
            storage: OpenClawStorageStatusPayload(
                totalBytes: total,
                freeBytes: free,
                usedBytes: max(0, total - free)),
            network: OpenClawNetworkStatusPayload(
                status: self.isConnected ? .satisfied : .requiresConnection,
                isExpensive: networkMetrics?.isExpensive ?? false,
                isConstrained: networkMetrics?.isConstrained ?? false,
                interfaces: networkMetrics?.isCellular == true ? [.cellular] : [.other]),
            uptimeSeconds: ProcessInfo.processInfo.systemUptime)
    }

    private func encodedResponse(id: String, payload: some Encodable) throws -> BridgeInvokeResponse {
        let data = try JSONEncoder().encode(payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileWriteInapplicableStringEncoding)
        }
        return BridgeInvokeResponse(id: id, ok: true, payloadJSON: json)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try JSONDecoder().decode(type, from: Data((json ?? "{}").utf8))
    }

    private static func errorResponse(
        id: String,
        code: OpenClawNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: id,
            ok: false,
            error: OpenClawNodeError(code: code, message: message))
    }

    private static func httpBaseURL(for link: GatewayConnectDeepLink) -> URL? {
        guard link.tls else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = link.host
        components.port = link.port
        return components.url
    }

    private static func gatewayID(for link: GatewayConnectDeepLink) -> String {
        "watch-direct:\(link.tls ? "https" : "http")://\(link.host.lowercased()):\(link.port)"
    }

    private static func endpointText(_ configuration: PersistedConfiguration) -> String {
        "\(configuration.link.tls ? "https" : "http")://\(configuration.link.host):\(configuration.link.port)"
    }

    private static func loadConfiguration() -> PersistedConfiguration? {
        guard let raw = GenericPasswordKeychainStore.loadString(
            service: keychainService,
            account: keychainAccount),
            let data = raw.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(PersistedConfiguration.self, from: data)
    }

    private static func saveConfiguration(_ configuration: PersistedConfiguration) -> Bool {
        guard let data = try? JSONEncoder().encode(configuration),
              let raw = String(data: data, encoding: .utf8)
        else { return false }
        return GenericPasswordKeychainStore.saveString(
            raw,
            service: self.keychainService,
            account: self.keychainAccount)
    }

    private func disconnectActiveSession() {
        self.isConnected = false
        guard let session = activeSession else { return }
        self.activeSession = nil
        self.sendDisconnect(session)
    }

    private func releaseActiveSession(_ session: ActiveSession) {
        guard self.activeSession == session else { return }
        self.activeSession = nil
        self.sendDisconnect(session)
    }

    private func sendDisconnect(_ session: ActiveSession) {
        Task { [weak self] in
            _ = try? await self?.request(
                baseURL: session.baseURL,
                path: "disconnect",
                method: "POST",
                token: session.token)
        }
    }

    private static func lastAcceptedSetupSentAtMs() -> Int64 {
        (UserDefaults.standard.object(forKey: self.lastSetupSentAtDefaultsKey) as? NSNumber)?.int64Value ?? 0
    }

    private static func saveLastAcceptedSetupSentAtMs(_ sentAtMs: Int64) {
        UserDefaults.standard.set(NSNumber(value: sentAtMs), forKey: self.lastSetupSentAtDefaultsKey)
    }
}

private struct WatchNetworkMetricsSnapshot {
    let isCellular: Bool
    let isExpensive: Bool
    let isConstrained: Bool
}

private final class WatchURLSessionMetrics: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var latest: WatchNetworkMetricsSnapshot?

    func snapshot() -> WatchNetworkMetricsSnapshot? {
        self.lock.lock()
        defer { lock.unlock() }
        return self.latest
    }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics)
    {
        guard let transaction = metrics.transactionMetrics.last else { return }
        let snapshot = WatchNetworkMetricsSnapshot(
            isCellular: transaction.isCellular,
            isExpensive: transaction.isExpensive,
            isConstrained: transaction.isConstrained)
        self.lock.lock()
        self.latest = snapshot
        self.lock.unlock()
    }

    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void)
    {
        completionHandler(nil)
    }
}
