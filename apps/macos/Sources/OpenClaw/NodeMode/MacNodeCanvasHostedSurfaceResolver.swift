import Foundation

struct MacNodeCanvasHostedSurfaceResolver: Sendable {
    private let currentSurfaceURL: @Sendable () async -> String?
    private let refreshSurfaceURL: @Sendable () async -> String?

    init(
        currentSurfaceURL: @escaping @Sendable () async -> String?,
        refreshSurfaceURL: @escaping @Sendable () async -> String?)
    {
        self.currentSurfaceURL = currentSurfaceURL
        self.refreshSurfaceURL = refreshSurfaceURL
    }

    func resolveA2UIURL(forceRefresh: Bool = false) async -> String? {
        if !forceRefresh,
           let currentSurface = await currentSurfaceURL(),
           let current = CanvasHostedURLResolver.resolveA2UIURL(surfaceURL: currentSurface)
        {
            return current
        }
        let refreshedSurface = await refreshSurfaceURL()
        return CanvasHostedURLResolver.resolveA2UIURL(surfaceURL: refreshedSurface)
    }

    func resolveTarget(_ target: String?) async throws -> CanvasHostedTarget? {
        guard let target, CanvasHostedURLResolver.isHostedTarget(target) else { return nil }
        if let refreshedSurface = await refreshSurfaceURL(),
           let resolved = CanvasHostedURLResolver.resolve(surfaceURL: refreshedSurface, target: target)
        {
            return resolved
        }
        if let currentSurface = await currentSurfaceURL(),
           let resolved = CanvasHostedURLResolver.resolve(surfaceURL: currentSurface, target: target)
        {
            return resolved
        }
        throw NSError(domain: "Canvas", code: 32, userInfo: [
            NSLocalizedDescriptionKey: "CANVAS_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        ])
    }
}
