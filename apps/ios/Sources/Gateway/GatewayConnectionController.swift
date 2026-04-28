import AVFoundation
import Contacts
import CoreLocation
import CoreMotion
import CryptoKit
import Darwin
import EventKit
import Foundation
import Network
import Observation
import OpenClawKit
import os
import Photos
import ReplayKit
import Security
import Speech
import SwiftUI
import UIKit

@MainActor
@Observable
final class GatewayConnectionController {
    struct TrustPrompt: Identifiable, Equatable {
        let stableID: String
        let gatewayName: String
        let host: String
        let port: Int
        let fingerprintSha256: String
        let isManual: Bool

        var id: String {
            self.stableID
        }
    }

    private(set) var gateways: [GatewayDiscoveryModel.DiscoveredGateway] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [GatewayDiscoveryModel.DebugLogEntry] = []
    private(set) var pendingTrustPrompt: TrustPrompt?

    private let discovery = GatewayDiscoveryModel()
    private weak var appModel: NodeAppModel?
    private var didAutoConnect = false
    private var pendingServiceResolvers: [String: GatewayServiceResolver] = [:]
    private var pendingTrustConnect: (url: URL, stableID: String, isManual: Bool)?

    init(appModel: NodeAppModel, startDiscovery: Bool = true) {
        self.appModel = appModel

        GatewaySettingsStore.bootstrapPersistence()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "gateway.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if startDiscovery {
            self.discovery.start()
        }
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func setScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            self.discovery.stop()
        case .active, .inactive:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        @unknown default:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
        }
    }

    func allowAutoConnectAgain() {
        self.didAutoConnect = false
        self.maybeAutoConnect()
    }

    func restartDiscovery() {
        self.discovery.stop()
        self.didAutoConnect = false
        self.discovery.start()
        self.updateFromDiscovery()
    }

    /// Returns `nil` when a connect attempt was started, otherwise returns a user-facing error.
    func connectWithDiagnostics(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async -> String? {
        await self.connectDiscoveredGateway(gateway)
    }

    private func connectDiscoveredGateway(
        _ gateway: GatewayDiscoveryModel.DiscoveredGateway) async -> String?
    {
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if instanceId.isEmpty {
            return "Missing instanceId (node.instanceId). Try restarting the app."
        }
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)

        // Resolve the service endpoint (SRV/A/AAAA). TXT is unauthenticated; do not route via TXT.
        guard let target = await self.resolveServiceEndpoint(gateway.endpoint) else {
            return "Failed to resolve the discovered gateway endpoint."
        }

        let stableID = gateway.stableID
        // Discovery is a LAN operation; refuse unauthenticated plaintext connects.
        let tlsRequired = true
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        guard gateway.tlsEnabled || stored != nil else {
            return "Discovered gateway is missing TLS and no trusted fingerprint is stored."
        }

        if tlsRequired, stored == nil {
            guard let url = self.buildGatewayURL(host: target.host, port: target.port, useTLS: true)
            else { return "Failed to build TLS URL for trust verification." }
            guard let fp = await self.probeTLSFingerprint(url: url) else {
                return "Failed to read TLS fingerprint from discovered gateway."
            }
            self.pendingTrustConnect = (url: url, stableID: stableID, isManual: false)
            self.pendingTrustPrompt = TrustPrompt(
                stableID: stableID,
                gatewayName: gateway.name,
                host: target.host,
                port: target.port,
                fingerprintSha256: fp,
                isManual: false)
            self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
            return nil
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }

        guard let url = self.buildGatewayURL(
            host: target.host,
            port: target.port,
            useTLS: tlsParams?.required == true)
        else { return "Failed to build discovered gateway URL." }
        GatewaySettingsStore.saveLastGatewayConnectionDiscovered(stableID: stableID, useTLS: true)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
        return nil
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        _ = await self.connectWithDiagnostics(gateway)
    }

    func connectManual(host: String, port: Int, useTLS: Bool) async {
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
        guard let resolvedPort = self.resolveManualPort(host: host, port: port, useTLS: resolvedUseTLS)
        else { return }
        let stableID = self.manualStableID(host: host, port: resolvedPort)
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if resolvedUseTLS, stored == nil {
            guard let url = self.buildGatewayURL(host: host, port: resolvedPort, useTLS: true) else { return }
            guard let fp = await self.probeTLSFingerprint(url: url) else {
                self.appModel?.gatewayStatusText =
                    "TLS handshake failed for \(host):\(resolvedPort). "
                        + "Remote gateways must use HTTPS/WSS."
                return
            }
            self.pendingTrustConnect = (url: url, stableID: stableID, isManual: true)
            self.pendingTrustPrompt = TrustPrompt(
                stableID: stableID,
                gatewayName: "\(host):\(resolvedPort)",
                host: host,
                port: resolvedPort,
                fingerprintSha256: fp,
                isManual: true)
            self.appModel?.gatewayStatusText = "Verify gateway TLS fingerprint"
            return
        }

        let tlsParams = stored.map { fp in
            GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
        }
        guard let url = self.buildGatewayURL(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true)
        else { return }
        GatewaySettingsStore.saveLastGatewayConnectionManual(
            host: host,
            port: resolvedPort,
            useTLS: resolvedUseTLS && tlsParams != nil,
            stableID: stableID)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
    }

    func connectLastKnown() async {
        guard let last = GatewaySettingsStore.loadLastGatewayConnection() else { return }
        switch last {
        case let .manual(host, port, useTLS, _):
            await self.connectManual(host: host, port: port, useTLS: useTLS)
        case let .discovered(stableID, _):
            guard let gateway = self.gateways.first(where: { $0.stableID == stableID }) else { return }
            _ = await self.connectDiscoveredGateway(gateway)
        }
    }

    /// Rebuild connect options from current local settings (caps/commands/permissions)
    /// and re-apply the active gateway config so capability changes take effect immediately.
    func refreshActiveGatewayRegistrationFromSettings() {
        guard let appModel else { return }
        guard let cfg = appModel.activeGatewayConnectConfig else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }

        let refreshedConfig = GatewayConnectConfig(
            url: cfg.url,
            stableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            nodeOptions: self.makeConnectOptions(stableID: cfg.stableID))
        appModel.applyGatewayConnectConfig(refreshedConfig)
    }

    func clearPendingTrustPrompt() {
        self.pendingTrustPrompt = nil
        self.pendingTrustConnect = nil
    }

    func acceptPendingTrustPrompt() async {
        guard let pending = self.pendingTrustConnect,
              let prompt = self.pendingTrustPrompt,
              pending.stableID == prompt.stableID
        else { return }

        GatewayTLSStore.saveFingerprint(prompt.fingerprintSha256, stableID: pending.stableID)
        self.clearPendingTrustPrompt()

        if pending.isManual {
            GatewaySettingsStore.saveLastGatewayConnectionManual(
                host: prompt.host,
                port: prompt.port,
                useTLS: true,
                stableID: pending.stableID)
        } else {
            GatewaySettingsStore.saveLastGatewayConnectionDiscovered(stableID: pending.stableID, useTLS: true)
        }

        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let tlsParams = GatewayTLSParams(
            required: true,
            expectedFingerprint: prompt.fingerprintSha256,
            allowTOFU: false,
            storeKey: pending.stableID)

        self.didAutoConnect = true
        self.startAutoConnect(
            url: pending.url,
            gatewayStableID: pending.stableID,
            tls: tlsParams,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
    }

    func declinePendingTrustPrompt() {
        self.clearPendingTrustPrompt()
        self.appModel?.gatewayStatusText = "Offline"
    }

    private func updateFromDiscovery() {
        let newGateways = self.discovery.gateways
        self.gateways = newGateways
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredGateway(from: newGateways)
        self.maybeAutoConnect()
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.gateways
            _ = self.discovery.statusText
            _ = self.discovery.debugLog
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateFromDiscovery()
                self.observeDiscovery()
            }
        }
    }

    private func maybeAutoConnect() {
        guard !self.didAutoConnect else { return }
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayServerName == nil else { return }

        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "gateway.autoconnect") else { return }
        let manualEnabled = defaults.bool(forKey: "gateway.manual.enabled")

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let bootstrapToken = GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)

        if manualEnabled {
            let manualHost = defaults.string(forKey: "gateway.manual.host")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !manualHost.isEmpty else { return }

            let manualPort = defaults.integer(forKey: "gateway.manual.port")
            let manualTLS = defaults.bool(forKey: "gateway.manual.tls")
            let resolvedUseTLS = self.resolveManualUseTLS(host: manualHost, useTLS: manualTLS)
            guard let resolvedPort = self.resolveManualPort(
                host: manualHost,
                port: manualPort,
                useTLS: resolvedUseTLS)
            else { return }

            let stableID = self.manualStableID(host: manualHost, port: resolvedPort)
            let tlsParams = self.resolveManualTLSParams(
                stableID: stableID,
                tlsEnabled: resolvedUseTLS,
                allowTOFUReset: self.shouldRequireTLS(host: manualHost))

            guard let url = self.buildGatewayURL(
                host: manualHost,
                port: resolvedPort,
                useTLS: tlsParams?.required == true)
            else { return }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: stableID,
                tls: tlsParams,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password)
            return
        }

        if let lastKnown = GatewaySettingsStore.loadLastGatewayConnection() {
            if case let .manual(host, port, useTLS, stableID) = lastKnown {
                let resolvedUseTLS = self.resolveManualUseTLS(host: host, useTLS: useTLS)
                let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
                let tlsParams = stored.map { fp in
                    GatewayTLSParams(required: true, expectedFingerprint: fp, allowTOFU: false, storeKey: stableID)
                }
                guard let url = self.buildGatewayURL(
                    host: host,
                    port: port,
                    useTLS: resolvedUseTLS && tlsParams != nil)
                else { return }

                // Security: autoconnect only to previously trusted gateways (stored TLS pin).
                guard tlsParams != nil else { return }

                self.didAutoConnect = true
                self.startAutoConnect(
                    url: url,
                    gatewayStableID: stableID,
                    tls: tlsParams,
                    token: token,
                    bootstrapToken: bootstrapToken,
                    password: password)
                return
            }
        }

        let preferredStableID = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastDiscoveredStableID = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let candidates = [preferredStableID, lastDiscoveredStableID].filter { !$0.isEmpty }
        if let targetStableID = candidates.first(where: { id in
            self.gateways.contains(where: { $0.stableID == id })
        }) {
            guard let target = self.gateways.first(where: { $0.stableID == targetStableID }) else { return }
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: target.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(target)
            }
            return
        }

        if self.gateways.count == 1, let gateway = self.gateways.first {
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            guard GatewayTLSStore.loadFingerprint(stableID: gateway.stableID) != nil else { return }

            self.didAutoConnect = true
            Task { [weak self] in
                guard let self else { return }
                _ = await self.connectDiscoveredGateway(gateway)
            }
            return
        }
    }

    private func attemptAutoReconnectIfNeeded() {
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        // Avoid starting duplicate connect loops while a prior config is active.
        guard appModel.activeGatewayConnectConfig == nil else { return }
        guard UserDefaults.standard.bool(forKey: "gateway.autoconnect") else { return }
        self.didAutoConnect = false
        self.maybeAutoConnect()
    }

    private func updateLastDiscoveredGateway(from gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        let defaults = UserDefaults.standard
        let preferred = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let existingLast = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred.isEmpty, existingLast.isEmpty else { return }
        guard let first = gateways.first else { return }

        defaults.set(first.stableID, forKey: "gateway.lastDiscoveredStableID")
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(first.stableID)
    }

    private func startAutoConnect(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?)
    {
        guard let appModel else { return }
        let connectOptions = self.makeConnectOptions(stableID: gatewayStableID)

        Task { [weak appModel] in
            guard let appModel else { return }
            await MainActor.run {
                appModel.gatewayStatusText = "Connecting…"
            }
            let cfg = GatewayConnectConfig(
                url: url,
                stableID: gatewayStableID,
                tls: tls,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                nodeOptions: connectOptions)
            appModel.applyGatewayConnectConfig(cfg)
        }
    }

    private func resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        allowTOFU: Bool) -> GatewayTLSParams?
    {
        let stableID = gateway.stableID
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        // Never let unauthenticated discovery (TXT) override a stored pin.
        if let stored {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        if gateway.tlsEnabled || gateway.tlsFingerprintSha256 != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveManualTLSParams(
        stableID: String,
        tlsEnabled: Bool,
        allowTOFUReset: Bool = false) -> GatewayTLSParams?
    {
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if tlsEnabled || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: false,
                storeKey: stableID)
        }

        return nil
    }

    private func probeTLSFingerprint(url: URL) async -> String? {
        await withCheckedContinuation { continuation in
            let probe = GatewayTLSFingerprintProbe(url: url, timeoutSeconds: 3) { fp in
                continuation.resume(returning: fp)
            }
            probe.start()
        }
    }

    private func resolveServiceEndpoint(_ endpoint: NWEndpoint) async -> (host: String, port: Int)? {
        guard case let .service(name, type, domain, _) = endpoint else { return nil }
        let key = "\(domain)|\(type)|\(name)"
        return await withCheckedContinuation { continuation in
            let resolver = GatewayServiceResolver(name: name, type: type, domain: domain) { [weak self] result in
                Task { @MainActor in
                    self?.pendingServiceResolvers[key] = nil
                    continuation.resume(returning: result)
                }
            }
            self.pendingServiceResolvers[key] = resolver
            resolver.start()
        }
    }

    private func resolveHostPortFromBonjourEndpoint(_ endpoint: NWEndpoint) async -> (host: String, port: Int)? {
        switch endpoint {
        case let .hostPort(host, port):
            (host: host.debugDescription, port: Int(port.rawValue))
        case let .service(name, type, domain, _):
            await Self.resolveBonjourServiceToHostPort(name: name, type: type, domain: domain)
        default:
            nil
        }
    }

    private static func resolveBonjourServiceToHostPort(
        name: String,
        type: String,
        domain: String,
        timeoutSeconds: TimeInterval = 3.0) async -> (host: String, port: Int)?
    {
        // NetService callbacks are delivered via a run loop. If we resolve from a thread without one,
        // we can end up never receiving callbacks, which in turn leaks the continuation and leaves
        // the UI stuck "connecting". Keep the whole lifecycle on the main run loop and always
        // resume the continuation exactly once (timeout/cancel safe).
        @MainActor
        final class Resolver: NSObject, @preconcurrency NetServiceDelegate {
            private var cont: CheckedContinuation<(host: String, port: Int)?, Never>?
            private let service: NetService
            private var timeoutTask: Task<Void, Never>?
            private var finished = false

            init(cont: CheckedContinuation<(host: String, port: Int)?, Never>, service: NetService) {
                self.cont = cont
                self.service = service
                super.init()
            }

            func start(timeoutSeconds: TimeInterval) {
                self.service.delegate = self
                self.service.schedule(in: .main, forMode: .default)

                // NetService has its own timeout, but we keep a manual one as a backstop in case
                // callbacks never arrive (e.g. local network permission issues).
                self.timeoutTask = Task { @MainActor [weak self] in
                    guard let self else { return }
                    let ns = UInt64(max(0.1, timeoutSeconds) * 1_000_000_000)
                    try? await Task.sleep(nanoseconds: ns)
                    self.finish(nil)
                }

                self.service.resolve(withTimeout: timeoutSeconds)
            }

            func netServiceDidResolveAddress(_ sender: NetService) {
                self.finish(Self.extractHostPort(sender))
            }

            func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
                _ = errorDict // currently best-effort; callers surface a generic failure
                self.finish(nil)
            }

            private func finish(_ result: (host: String, port: Int)?) {
                guard !self.finished else { return }
                self.finished = true

                self.timeoutTask?.cancel()
                self.timeoutTask = nil

                self.service.stop()
                self.service.remove(from: .main, forMode: .default)

                let c = self.cont
                self.cont = nil
                c?.resume(returning: result)
            }

            private static func extractHostPort(_ svc: NetService) -> (host: String, port: Int)? {
                let port = svc.port

                if let host = svc.hostName?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty {
                    return (host: host, port: port)
                }

                guard let addrs = svc.addresses else { return nil }
                for addrData in addrs {
                    let host = addrData.withUnsafeBytes { ptr -> String? in
                        guard let base = ptr.baseAddress, !ptr.isEmpty else { return nil }
                        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))

                        let rc = getnameinfo(
                            base.assumingMemoryBound(to: sockaddr.self),
                            socklen_t(ptr.count),
                            &buffer,
                            socklen_t(buffer.count),
                            nil,
                            0,
                            NI_NUMERICHOST)
                        guard rc == 0 else { return nil }
                        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
                        return String(bytes: bytes, encoding: .utf8)
                    }

                    if let host, !host.isEmpty {
                        return (host: host, port: port)
                    }
                }

                return nil
            }
        }

        return await withCheckedContinuation { cont in
            Task { @MainActor in
                let service = NetService(domain: domain, type: type, name: name)
                let resolver = Resolver(cont: cont, service: service)
                // Keep the resolver alive for the lifetime of the NetService resolve.
                objc_setAssociatedObject(service, "resolver", resolver, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
                resolver.start(timeoutSeconds: timeoutSeconds)
            }
        }
    }

    private func buildGatewayURL(host: String, port: Int, useTLS: Bool) -> URL? {
        let scheme = useTLS ? "wss" : "ws"
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.url
    }

    private func resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        useTLS || self.shouldRequireTLS(host: host)
    }

    private func shouldRequireTLS(host: String) -> Bool {
        !Self.isLoopbackHost(host)
    }

    private func shouldForceTLS(host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty { return false }
        return trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.")
    }

    private static func isLoopbackHost(_ rawHost: String) -> Bool {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !host.isEmpty else { return false }

        if host.hasPrefix("[") && host.hasSuffix("]") {
            host.removeFirst()
            host.removeLast()
        }
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if let zoneIndex = host.firstIndex(of: "%") {
            host = String(host[..<zoneIndex])
        }
        if host.isEmpty { return false }

        if host == "localhost" || host == "0.0.0.0" || host == "::" {
            return true
        }
        return Self.isLoopbackIPv4(host) || Self.isLoopbackIPv6(host)
    }

    private static func isLoopbackIPv4(_ host: String) -> Bool {
        var addr = in_addr()
        let parsed = host.withCString { inet_pton(AF_INET, $0, &addr) == 1 }
        guard parsed else { return false }
        let value = UInt32(bigEndian: addr.s_addr)
        let firstOctet = UInt8((value >> 24) & 0xFF)
        return firstOctet == 127
    }

    private static func isLoopbackIPv6(_ host: String) -> Bool {
        var addr = in6_addr()
        let parsed = host.withCString { inet_pton(AF_INET6, $0, &addr) == 1 }
        guard parsed else { return false }
        return withUnsafeBytes(of: &addr) { rawBytes in
            let bytes = rawBytes.bindMemory(to: UInt8.self)
            let isV6Loopback = bytes[0..<15].allSatisfy { $0 == 0 } && bytes[15] == 1
            if isV6Loopback { return true }

            let isMappedV4 = bytes[0..<10].allSatisfy { $0 == 0 } && bytes[10] == 0xFF && bytes[11] == 0xFF
            return isMappedV4 && bytes[12] == 127
        }
    }

    private func manualStableID(host: String, port: Int) -> String {
        "manual|\(host.lowercased())|\(port)"
    }

    private func makeConnectOptions(stableID: String?) -> GatewayConnectOptions {
        let defaults = UserDefaults.standard
        let displayName = self.resolvedDisplayName(defaults: defaults)
        let resolvedClientId = self.resolvedClientId(defaults: defaults, stableID: stableID)

        return GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: self.currentCaps(),
            commands: self.currentCommands(),
            permissions: self.currentPermissions(),
            clientId: resolvedClientId,
            clientMode: "node",
            clientDisplayName: displayName)
    }

    private func resolvedClientId(defaults: UserDefaults, stableID: String?) -> String {
        if let stableID,
           let override = GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID)
        {
            return override
        }
        let manualClientId = defaults.string(forKey: "gateway.manual.clientId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if manualClientId?.isEmpty == false {
            return manualClientId!
        }
        return "openclaw-ios"
    }

    private func resolveManualPort(host: String, port: Int, useTLS: Bool) -> Int? {
        if port > 0 {
            return port <= 65535 ? port : nil
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return nil }
        if useTLS, self.shouldForceTLS(host: trimmedHost) {
            return 443
        }
        return 18789
    }

    private func resolvedDisplayName(defaults: UserDefaults) -> String {
        let key = "node.displayName"
        let existingRaw = defaults.string(forKey: key)
        let resolved = NodeDisplayName.resolve(
            existing: existingRaw,
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let existing = existingRaw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if existing.isEmpty || NodeDisplayName.isGeneric(existing) {
            defaults.set(resolved, forKey: key)
        }
        return resolved
    }

    private func currentCaps() -> [String] {
        var caps = [OpenClawCapability.canvas.rawValue, OpenClawCapability.screen.rawValue]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(OpenClawCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(OpenClawCapability.voiceWake.rawValue) }

        let locationModeRaw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        let locationMode = OpenClawLocationMode(rawValue: locationModeRaw) ?? .off
        if locationMode != .off { caps.append(OpenClawCapability.location.rawValue) }

        caps.append(OpenClawCapability.device.rawValue)
        if WatchMessagingService.isSupportedOnDevice() {
            caps.append(OpenClawCapability.watch.rawValue)
        }
        caps.append(OpenClawCapability.photos.rawValue)
        caps.append(OpenClawCapability.contacts.rawValue)
        caps.append(OpenClawCapability.calendar.rawValue)
        caps.append(OpenClawCapability.reminders.rawValue)
        if Self.motionAvailable() {
            caps.append(OpenClawCapability.motion.rawValue)
        }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            OpenClawCanvasA2UICommand.reset.rawValue,
            OpenClawScreenCommand.record.rawValue,
            OpenClawSystemCommand.notify.rawValue,
            OpenClawChatCommand.push.rawValue,
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
        }
        if caps.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if caps.contains(OpenClawCapability.device.rawValue) {
            commands.append(OpenClawDeviceCommand.status.rawValue)
            commands.append(OpenClawDeviceCommand.info.rawValue)
        }
        if caps.contains(OpenClawCapability.watch.rawValue) {
            commands.append(OpenClawWatchCommand.status.rawValue)
            commands.append(OpenClawWatchCommand.notify.rawValue)
        }
        if caps.contains(OpenClawCapability.photos.rawValue) {
            commands.append(OpenClawPhotosCommand.latest.rawValue)
        }
        if caps.contains(OpenClawCapability.contacts.rawValue) {
            commands.append(OpenClawContactsCommand.search.rawValue)
            commands.append(OpenClawContactsCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.calendar.rawValue) {
            commands.append(OpenClawCalendarCommand.events.rawValue)
            commands.append(OpenClawCalendarCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.reminders.rawValue) {
            commands.append(OpenClawRemindersCommand.list.rawValue)
            commands.append(OpenClawRemindersCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.motion.rawValue) {
            commands.append(OpenClawMotionCommand.activity.rawValue)
            commands.append(OpenClawMotionCommand.pedometer.rawValue)
        }

        return commands
    }

    private func currentPermissions() -> [String: Bool] {
        var permissions: [String: Bool] = [:]
        permissions["camera"] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        permissions["microphone"] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        permissions["speechRecognition"] = SFSpeechRecognizer.authorizationStatus() == .authorized
        permissions["location"] = Self.isLocationAuthorized(
            status: CLLocationManager().authorizationStatus)
            && CLLocationManager.locationServicesEnabled()
        permissions["screenRecording"] = RPScreenRecorder.shared().isAvailable

        let photoStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        permissions["photos"] = photoStatus == .authorized || photoStatus == .limited
        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        permissions["contacts"] = contactsStatus == .authorized || contactsStatus == .limited

        let calendarStatus = EKEventStore.authorizationStatus(for: .event)
        permissions["calendar"] = Self.hasEventKitAccess(calendarStatus)
        let remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        permissions["reminders"] = Self.hasEventKitAccess(remindersStatus)

        let motionStatus = CMMotionActivityManager.authorizationStatus()
        let pedometerStatus = CMPedometer.authorizationStatus()
        permissions["motion"] =
            motionStatus == .authorized || pedometerStatus == .authorized

        let watchStatus = WatchMessagingService.currentStatusSnapshot()
        permissions["watchSupported"] = watchStatus.supported
        permissions["watchPaired"] = watchStatus.paired
        permissions["watchAppInstalled"] = watchStatus.appInstalled
        permissions["watchReachable"] = watchStatus.reachable

        return permissions
    }

    private static func isLocationAuthorized(status: CLAuthorizationStatus) -> Bool {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            true
        default:
            false
        }
    }

    private static func hasEventKitAccess(_ status: EKAuthorizationStatus) -> Bool {
        status == .fullAccess || status == .writeOnly
    }

    private static func motionAvailable() -> Bool {
        CMMotionActivityManager.isActivityAvailable() || CMPedometer.isStepCountingAvailable()
    }
}

#if DEBUG
extension GatewayConnectionController {
    func _test_resolvedDisplayName(defaults: UserDefaults) -> String {
        self.resolvedDisplayName(defaults: defaults)
    }

    func _test_currentCaps() -> [String] {
        self.currentCaps()
    }

    func _test_currentCommands() -> [String] {
        self.currentCommands()
    }

    func _test_currentPermissions() -> [String: Bool] {
        self.currentPermissions()
    }

    func _test_platformString() -> String {
        DeviceInfoHelper.platformString()
    }

    func _test_deviceFamily() -> String {
        DeviceInfoHelper.deviceFamily()
    }

    func _test_modelIdentifier() -> String {
        DeviceInfoHelper.modelIdentifier()
    }

    func _test_appVersion() -> String {
        DeviceInfoHelper.appVersion()
    }

    func _test_setGateways(_ gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        self.gateways = gateways
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }

    func _test_didAutoConnect() -> Bool {
        self.didAutoConnect
    }

    func _test_resolveDiscoveredTLSParams(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        allowTOFU: Bool) -> GatewayTLSParams?
    {
        self.resolveDiscoveredTLSParams(gateway: gateway, allowTOFU: allowTOFU)
    }

    func _test_resolveManualUseTLS(host: String, useTLS: Bool) -> Bool {
        self.resolveManualUseTLS(host: host, useTLS: useTLS)
    }

    func _test_resolveManualPort(host: String, port: Int, useTLS: Bool) -> Int? {
        self.resolveManualPort(host: host, port: port, useTLS: useTLS)
    }
}
#endif

private final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
    private struct ProbeState {
        var didFinish = false
        var session: URLSession?
        var task: URLSessionWebSocketTask?
    }

    private let url: URL
    private let timeoutSeconds: Double
    private let onComplete: (String?) -> Void
    private let state = OSAllocatedUnfairLock(initialState: ProbeState())

    init(url: URL, timeoutSeconds: Double, onComplete: @escaping (String?) -> Void) {
        self.url = url
        self.timeoutSeconds = timeoutSeconds
        self.onComplete = onComplete
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = self.timeoutSeconds
        config.timeoutIntervalForResource = self.timeoutSeconds
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: self.url)
        self.state.withLock { s in
            s.session = session
            s.task = task
        }
        task.resume()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.timeoutSeconds) { [weak self] in
            self?.finish(nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        let fp = GatewayTLSFingerprintProbe.certificateFingerprint(trust)
        completionHandler(.cancelAuthenticationChallenge, nil)
        self.finish(fp)
    }

    private func finish(_ fingerprint: String?) {
        typealias FinishState = (Bool, URLSessionWebSocketTask?, URLSession?)
        let (shouldComplete, taskToCancel, sessionToInvalidate) = self.state.withLock { s -> FinishState in
            guard !s.didFinish else { return (false, nil, nil) }
            s.didFinish = true
            let task = s.task
            let session = s.session
            s.task = nil
            s.session = nil
            return (true, task, session)
        }
        guard shouldComplete else { return }
        taskToCancel?.cancel(with: .goingAway, reason: nil)
        sessionToInvalidate?.invalidateAndCancel()
        self.onComplete(fingerprint)
    }

    private static func certificateFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let cert = chain.first
        else {
            return nil
        }
        let data = SecCertificateCopyData(cert) as Data
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
