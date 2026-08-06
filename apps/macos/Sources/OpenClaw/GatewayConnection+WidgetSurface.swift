import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

private let gatewayWidgetSurfaceLogger = Logger(subsystem: "ai.openclaw", category: "gateway.widget-surface")

private struct PluginSurfaceRefreshResponse: Decodable {
    let pluginSurfaceUrls: [String: AnyCodable]?
}

extension GatewayConnection {
    func canvasPluginSurfaceUrl() async -> String? {
        self.canvasPluginSurfaceURL
    }

    func canvasPluginSurfaceRoute() async -> GatewayCanvasHostRoute? {
        self.currentCanvasPluginSurfaceRoute()
    }

    func refreshCanvasPluginSurfaceRoute(replacing observedURL: String?) async -> GatewayCanvasHostRoute? {
        if self.canvasPluginSurfaceURL != observedURL {
            return self.currentCanvasPluginSurfaceRoute()
        }
        if let activeRefresh = self.canvasPluginSurfaceRefresh {
            return await activeRefresh.task.value
        }
        guard let lease = await self.captureServerLease(), !Task.isCancelled else { return nil }
        // Capturing the physical connection before spawning prevents a canceled
        // refresh from adopting a replacement connection when its task starts.
        if self.canvasPluginSurfaceURL != observedURL {
            return self.currentCanvasPluginSurfaceRoute()
        }
        if let activeRefresh = self.canvasPluginSurfaceRefresh {
            return await activeRefresh.task.value
        }
        let id = UUID()
        let task = Task<GatewayCanvasHostRoute?, Never> { [weak self] in
            guard let self, !Task.isCancelled else { return nil }
            return await self.requestCanvasPluginSurfaceRefresh(
                replacing: observedURL,
                ifCurrentServerLease: lease)
        }
        // Install before the task's first suspension so sibling widgets share
        // one rotation instead of invalidating each other's new capability.
        self.canvasPluginSurfaceRefresh = CanvasPluginSurfaceRefresh(id: id, task: task)
        let route = await task.value
        if self.canvasPluginSurfaceRefresh?.id == id {
            self.canvasPluginSurfaceRefresh = nil
        }
        return route
    }

    private func requestCanvasPluginSurfaceRefresh(
        replacing observedURL: String?,
        ifCurrentServerLease lease: ServerLease) async -> GatewayCanvasHostRoute?
    {
        guard !Task.isCancelled else { return nil }
        var params = ["surface": AnyCodable("canvas")]
        if let observedURL {
            params["observedUrl"] = AnyCodable(observedURL)
        }
        do {
            let data = try await self.request(
                method: "plugin.surface.refresh",
                params: params,
                timeoutMs: 8000,
                ifCurrentServerLease: lease)
            let response = try JSONDecoder().decode(PluginSurfaceRefreshResponse.self, from: data)
            guard !Task.isCancelled, await self.isCurrentServerLease(lease) else { return nil }
            if self.canvasPluginSurfaceURL != observedURL {
                return self.currentCanvasPluginSurfaceRoute()
            }
            let raw = response.pluginSurfaceUrls?["canvas"]?.value as? String
            guard let refreshed = GatewayPluginSurfaceURL.canonicalize(
                raw: raw,
                against: self.configuredGatewayURL())
            else { return nil }
            self.canvasPluginSurfaceURL = refreshed
            return self.currentCanvasPluginSurfaceRoute()
        } catch {
            gatewayWidgetSurfaceLogger.debug(
                "plugin.surface.refresh failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func currentCanvasPluginSurfaceRoute() -> GatewayCanvasHostRoute? {
        guard let url = self.canvasPluginSurfaceURL else { return nil }
        return GatewayCanvasHostRoute(
            url: url,
            tlsFingerprintSHA256: self.configuredTLSFingerprintSHA256())
    }

    func installCanvasPluginSurfaceURL(from snapshot: HelloOk) {
        let raw = snapshot.pluginsurfaceurls?["canvas"]?.value as? String
        self.resetCanvasPluginSurfaceState()
        self.canvasPluginSurfaceURL = GatewayPluginSurfaceURL.canonicalize(
            raw: raw,
            against: self.configuredGatewayURL())
    }

    func resetCanvasPluginSurfaceState() {
        self.canvasPluginSurfaceRefresh?.task.cancel()
        self.canvasPluginSurfaceRefresh = nil
        self.canvasPluginSurfaceURL = nil
    }
}
