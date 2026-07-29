import Foundation
import OpenClawKit

enum A2UIReadyState {
    case ready
    case hostUnavailable
}

extension NodeAppModel {
    func showA2UIOnConnectIfNeeded() async {
        await MainActor.run {
            // Keep the bundled home canvas as the default connected view.
            // Agents can still explicitly present a remote or local canvas later.
            self.screen.showDefaultCanvas()
        }
    }

    func ensureA2UIReadyWithCapabilityRefresh(timeoutMs: Int = 5000) async -> A2UIReadyState {
        if self.screen.isShowingLocalA2UI(),
           await self.screen.waitForA2UIReady(timeoutMs: timeoutMs)
        {
            return .ready
        }

        self.screen.showLocalA2UI()
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return .ready
        }
        return .hostUnavailable
    }

    func showLocalCanvasOnDisconnect() {
        self.screen.showDefaultCanvas()
    }
}
