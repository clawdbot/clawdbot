#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import WebKit

#if os(iOS)
import UIKit

typealias ChatInlineWidgetSnapshotImage = UIImage
#elseif os(macOS)
import AppKit

typealias ChatInlineWidgetSnapshotImage = NSImage
#endif

struct ChatInlineWidgetSnapshotRequest: Equatable {
    enum Action: Equatable {
        case copy
        case save
    }

    let id = UUID()
    let action: Action
    let generation: UUID
    let resource: OpenClawChatWidgetResource
}

enum ChatInlineWidgetSnapshotOutcome {
    case success(ChatInlineWidgetSnapshotRequest, ChatInlineWidgetSnapshotImage)
    case failure(ChatInlineWidgetSnapshotRequest)
}

@MainActor
final class ChatInlineWidgetSnapshotCapture {
    private var request: ChatInlineWidgetSnapshotRequest?
    private weak var webView: WKWebView?
    private var generation: UUID?
    private var resource: OpenClawChatWidgetResource?

    func capture(
        _ request: ChatInlineWidgetSnapshotRequest?,
        from webView: WKWebView,
        generation: UUID,
        resource: OpenClawChatWidgetResource,
        onSnapshot: @escaping @MainActor @Sendable (ChatInlineWidgetSnapshotOutcome) -> Void)
    {
        if self.webView !== webView || self.generation != generation || self.resource != resource {
            self.invalidate()
        }
        guard let request,
              request.generation == generation,
              request.resource == resource,
              request.id != self.request?.id
        else { return }
        self.request = request
        self.webView = webView
        self.generation = generation
        self.resource = resource

        webView.takeSnapshot(with: WKSnapshotConfiguration()) { [weak self, weak webView] image, _ in
            guard let self,
                  let webView,
                  self.request == request,
                  self.webView === webView,
                  self.generation == request.generation,
                  self.resource == request.resource
            else { return }
            self.invalidate()
            onSnapshot(image.map { .success(request, $0) } ?? .failure(request))
        }
    }

    func invalidate() {
        self.request = nil
        self.webView = nil
        self.generation = nil
        self.resource = nil
    }
}
#endif
