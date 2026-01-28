import SwiftUI
import Testing
@testable import Moltbot

@Suite(.serialized)
@MainActor
struct TailscaleIntegrationSectionTests {
    @Test func tailscaleSectionBuildsBodyWhenNotInstalled() {
        let service = TailscaleService(isInstalled: false, isRunning: false, statusError: "not installed")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(mode: "off", requireCredentials: false, statusMessage: "Idle")
        _ = view.body
    }

    @Test func tailscaleSectionBuildsBodyForServeMode() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: true,
            tailscaleHostname: "moltbot.tailnet.ts.net",
            tailscaleIP: "100.64.0.1")
        var view = TailscaleIntegrationSection(connectionMode: .local, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "serve",
            requireCredentials: true,
            password: "secret",
            statusMessage: "Running")
        _ = view.body
    }

    @Test func tailscaleSectionBuildsBodyForFunnelMode() {
        let service = TailscaleService(
            isInstalled: true,
            isRunning: false,
            tailscaleHostname: nil,
            tailscaleIP: nil,
            statusError: "not running")
        var view = TailscaleIntegrationSection(connectionMode: .remote, isPaused: false)
        view.setTestingService(service)
        view.setTestingState(
            mode: "funnel",
            requireCredentials: false,
            statusMessage: "Needs start",
            validationMessage: "Invalid token")
        _ = view.body
    }
}
