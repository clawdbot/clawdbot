import Foundation
import OpenClawKit
import OpenClawProtocol

func whatsappLoginWaitRequestTimeoutMs(
    startedAt: Date,
    timeoutMs: Int,
    didRunFinalWait: inout Bool,
    now: Date = Date()) -> Int?
{
    let elapsedMs = Int(now.timeIntervalSince(startedAt) * 1000)
    let remainingMs = max(timeoutMs - elapsedMs, 0)
    if remainingMs > 0 {
        return remainingMs
    }
    if didRunFinalWait {
        return nil
    }
    didRunFinalWait = true
    return 1
}

func whatsappLoginStartParams(force: Bool) -> [String: AnyCodable] {
    [
        "channel": AnyCodable("whatsapp"),
        "force": AnyCodable(force),
        "timeoutMs": AnyCodable(30000),
    ]
}

func whatsappLoginWaitParams(
    timeoutMs: Int,
    currentQrDataUrl: String?,
    sessionKey: String? = nil) -> [String: AnyCodable]
{
    var params: [String: AnyCodable] = [
        "channel": AnyCodable("whatsapp"),
        "timeoutMs": AnyCodable(timeoutMs),
    ]
    if let currentQrDataUrl {
        params["currentQrDataUrl"] = AnyCodable(currentQrDataUrl)
    }
    if let sessionKey {
        params["sessionKey"] = AnyCodable(sessionKey)
    }
    return params
}

extension ChannelsStore {
    func start() {
        guard !self.isPreview else { return }
        self.startCount += 1
        guard self.startCount == 1 else { return }
        guard self.pollTask == nil else { return }
        GatewayPushSubscription
            .restartTask(task: &self.gatewayPushTask, connection: self.gateway) { [weak self] delivery in
                guard let self else { return }
                if let source = self.source, !self.owns(source) { self.clearSource() }
                guard let push = delivery.push else { return }
                if self.source == nil { self.adoptSource(delivery.serverLease) }
                self.handleGatewayPush(push)
            }
        self.pollTask = Task.detached { [weak self] in
            guard let self else { return }
            await self.refresh(probe: false)
            async let schemaLoad: Void = self.loadConfigSchema()
            async let configLoad: Void = self.loadConfig(force: false)
            _ = await (schemaLoad, configLoad)
            while await SimpleTaskSupport.waitForNextOperation(interval: self.interval) {
                await self.refresh(probe: false)
            }
        }
    }

    func stop() {
        guard !self.isPreview else { return }
        guard self.startCount > 0 else { return }
        self.startCount -= 1
        guard self.startCount == 0 else { return }
        self.pollTask?.cancel()
        self.pollTask = nil
        self.gatewayPushTask?.cancel()
        self.gatewayPushTask = nil
    }

    static func gatewayPushRequestsConfigRefresh(_ push: GatewayPush) -> Bool {
        switch push {
        case let .event(event):
            event.event == "config.changed"
        case .snapshot, .seqGap:
            true
        }
    }

    private func handleGatewayPush(_ push: GatewayPush) {
        guard Self.gatewayPushRequestsConfigRefresh(push) else { return }
        // Change events contain only a hash; refetch without overwriting a dirty local draft.
        guard let source = self.source else { return }
        Task {
            await self.loadConfig(force: false, refresh: true, source: source)
            if case .snapshot = push {
                await self.refresh(probe: false, source: source)
                await self.loadConfigSchema(source: source)
            }
        }
    }

    func refresh(probe: Bool, source expected: Source? = nil) async {
        guard let source = await self.resolveSource(expected) else { return }
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { if self.owns(source) { self.isRefreshing = false } }

        do {
            let statusTimeoutMs = probe ? 8000 : 2500
            let params: [String: AnyCodable] = [
                "probe": AnyCodable(probe),
                "timeoutMs": AnyCodable(statusTimeoutMs),
            ]
            let snap: ChannelsStatusSnapshot = try await self.gateway.requestDecoded(
                method: .channelsStatus,
                params: params,
                timeoutMs: probe ? 12000 : 5000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            self.snapshot = snap
            self.lastSuccess = Date()
            self.lastError = nil
        } catch {
            guard self.owns(source) else { return }
            self.lastError = error.localizedDescription
        }
    }

    func startWhatsAppLogin(force: Bool, autoWait: Bool = true) async {
        guard let source = await self.resolveSource() else { return }
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { if self.owns(source) { self.whatsappBusy = false } }
        var shouldAutoWait = false
        do {
            let params = whatsappLoginStartParams(force: force)
            let result: WhatsAppLoginStartResult = try await self.gateway.requestDecoded(
                method: .webLoginStart,
                params: params,
                timeoutMs: 35000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            self.whatsappLoginMessage = result.message
            self.whatsappLoginQrDataUrl = result.qrDataUrl
            self.whatsappLoginSessionKey = result.sessionKey
            self.whatsappLoginConnected = result.connected
            shouldAutoWait = autoWait && result.qrDataUrl != nil
        } catch {
            guard self.owns(source) else { return }
            self.whatsappLoginMessage = error.localizedDescription
            self.whatsappLoginQrDataUrl = nil
            self.whatsappLoginSessionKey = nil
            self.whatsappLoginConnected = nil
        }
        await self.refresh(probe: true, source: source)
        if shouldAutoWait, self.owns(source) {
            Task { await self.waitWhatsAppLogin(source: source) }
        }
    }

    private func waitWhatsAppLogin(timeoutMs: Int = 120_000, source: Source) async {
        guard self.owns(source) else { return }
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { if self.owns(source) { self.whatsappBusy = false } }
        let startedAt = Date()
        var didRunFinalWait = false
        var retryDelays = GatewayConnection.requestRetryDelaysMs.makeIterator()
        do {
            while let remainingMs = whatsappLoginWaitRequestTimeoutMs(
                startedAt: startedAt,
                timeoutMs: timeoutMs,
                didRunFinalWait: &didRunFinalWait)
            {
                guard self.owns(source) else { return }
                let params = whatsappLoginWaitParams(
                    timeoutMs: remainingMs,
                    currentQrDataUrl: self.whatsappLoginQrDataUrl,
                    sessionKey: self.whatsappLoginSessionKey)
                do {
                    let result: WhatsAppLoginWaitResult = try await self.gateway.requestDecoded(
                        method: .webLoginWait,
                        params: params,
                        timeoutMs: Double(remainingMs) + 5000,
                        ifCurrentRoute: source.lease.route)
                    guard self.owns(source) else { return }
                    self.applyWhatsAppLoginWaitResult(result)
                    if result.connected || result.qrDataUrl == nil || didRunFinalWait { break }
                    retryDelays = GatewayConnection.requestRetryDelaysMs.makeIterator()
                } catch {
                    try Task.checkCancellation()
                    guard self.owns(source) else { return }
                    guard (error as NSError).domain == URLError.errorDomain,
                          !didRunFinalWait, let delayMs = retryDelays.next()
                    else { throw error }
                    // Retry this QR session on its existing route without extending
                    // the original deadline or consuming its final one-shot poll.
                    let delayBudgetMs = max(0, timeoutMs - Int(Date().timeIntervalSince(startedAt) * 1000))
                    try await Task.sleep(for: .milliseconds(min(delayMs, delayBudgetMs)))
                }
            }
        } catch {
            guard self.owns(source) else { return }
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true, source: source)
    }

    func logoutWhatsApp() async {
        guard let source = await self.resolveSource() else { return }
        guard !self.whatsappBusy else { return }
        self.whatsappBusy = true
        defer { if self.owns(source) { self.whatsappBusy = false } }
        do {
            let params: [String: AnyCodable] = [
                "channel": AnyCodable("whatsapp"),
            ]
            let result: ChannelLogoutResult = try await self.gateway.requestDecoded(
                method: .channelsLogout,
                params: params,
                timeoutMs: 15000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            self.whatsappLoginMessage = result.cleared
                ? "Logged out and cleared credentials."
                : "No WhatsApp session found."
            self.whatsappLoginQrDataUrl = nil
            self.whatsappLoginSessionKey = nil
        } catch {
            guard self.owns(source) else { return }
            self.whatsappLoginMessage = error.localizedDescription
        }
        await self.refresh(probe: true, source: source)
    }

    func logoutTelegram() async {
        guard let source = await self.resolveSource() else { return }
        guard !self.telegramBusy else { return }
        self.telegramBusy = true
        defer { if self.owns(source) { self.telegramBusy = false } }
        do {
            let params: [String: AnyCodable] = [
                "channel": AnyCodable("telegram"),
            ]
            let result: ChannelLogoutResult = try await self.gateway.requestDecoded(
                method: .channelsLogout,
                params: params,
                timeoutMs: 15000,
                ifCurrentRoute: source.lease.route)
            guard self.owns(source) else { return }
            if result.envToken == true {
                self.configStatus = "Telegram token still set via env; config cleared."
            } else {
                self.configStatus = result.cleared
                    ? "Telegram token cleared."
                    : "No Telegram token configured."
            }
            await self.loadConfig(source: source)
        } catch {
            guard self.owns(source) else { return }
            self.configStatus = error.localizedDescription
        }
        await self.refresh(probe: true, source: source)
    }
}

private struct WhatsAppLoginStartResult: Codable {
    let qrDataUrl: String?
    let message: String
    let sessionKey: String?
    let connected: Bool?
}

struct WhatsAppLoginWaitResult: Codable {
    let connected: Bool
    let message: String
    let qrDataUrl: String?
}

private struct ChannelLogoutResult: Codable {
    let channel: String?
    let accountId: String?
    let cleared: Bool
    let envToken: Bool?
}
