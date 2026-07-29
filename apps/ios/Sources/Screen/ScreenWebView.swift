import OpenClawKit
import SwiftUI
import WebKit

struct ScreenWebView: UIViewRepresentable {
    var controller: ScreenController

    func makeCoordinator() -> ScreenWebViewCoordinator {
        ScreenWebViewCoordinator(controller: self.controller)
    }

    func makeUIView(context: Context) -> UIView {
        context.coordinator.makeContainerView()
    }

    func updateUIView(_: UIView, context: Context) {
        context.coordinator.updateController(self.controller)
    }

    static func dismantleUIView(_: UIView, coordinator: ScreenWebViewCoordinator) {
        coordinator.teardown()
    }
}

@MainActor
final class ScreenWebViewCoordinator: NSObject {
    private weak var controller: ScreenController?
    private let navigationDelegate = ScreenNavigationDelegate()
    private let a2uiActionHandler = CanvasA2UIActionMessageHandler()
    private let userContentController = WKUserContentController()

    private(set) var managedWebView: WKWebView?
    private weak var containerView: UIView?

    init(controller: ScreenController) {
        self.controller = controller
        super.init()
        self.navigationDelegate.controller = controller
        self.a2uiActionHandler.controller = controller
    }

    func makeContainerView() -> UIView {
        if let containerView {
            return containerView
        }

        let container = UIView(frame: .zero)
        container.backgroundColor = .black

        let webView = Self.makeWebView(userContentController: self.userContentController)
        webView.navigationDelegate = self.navigationDelegate
        self.installA2UIHandlers()

        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        self.managedWebView = webView
        self.containerView = container
        self.controller?.attachWebView(webView)
        return container
    }

    func updateController(_ controller: ScreenController) {
        let previousController = self.controller
        let controllerChanged = self.controller !== controller
        self.controller = controller
        self.navigationDelegate.controller = controller
        self.a2uiActionHandler.controller = controller
        if controllerChanged, let managedWebView {
            previousController?.detachWebView(managedWebView)
            controller.attachWebView(managedWebView)
        }
    }

    func teardown() {
        if let managedWebView {
            self.controller?.detachWebView(managedWebView)
            managedWebView.navigationDelegate = nil
        }
        self.removeA2UIHandlers()
        self.navigationDelegate.controller = nil
        self.a2uiActionHandler.controller = nil
        self.managedWebView = nil
        self.containerView = nil
    }

    private static func makeWebView(userContentController: WKUserContentController) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: config)
        // Canvas scaffold is a fully self-contained HTML page; avoid relying on transparency underlays.
        webView.isOpaque = true
        webView.backgroundColor = .black

        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.scrollIndicatorInsets = .zero
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false

        return webView
    }

    private func installA2UIHandlers() {
        for name in CanvasA2UIActionMessageHandler.handlerNames {
            self.userContentController.add(self.a2uiActionHandler, name: name)
        }
    }

    private func removeA2UIHandlers() {
        for name in CanvasA2UIActionMessageHandler.handlerNames {
            self.userContentController.removeScriptMessageHandler(forName: name)
        }
    }
}

// MARK: - Navigation Delegate

/// Handles navigation policy to intercept OpenClaw deep links from canvas.
@MainActor
private final class ScreenNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var controller: ScreenController?

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        let scheme = url.scheme?.lowercased()
        if scheme == "openclaw" || scheme == "openclaw-debug" {
            decisionHandler(.cancel)
            self.controller?.onDeepLink?(url)
            return
        }

        decisionHandler(.allow)
    }

    func webView(
        _: WKWebView,
        didFailProvisionalNavigation _: WKNavigation?,
        withError error: any Error)
    {
        self.controller?.errorText = error.localizedDescription
    }

    func webView(_: WKWebView, didFinish _: WKNavigation?) {
        self.controller?.errorText = nil
        self.controller?.applyDebugStatusIfNeeded()
        self.controller?.applyHomeCanvasStateIfNeeded()
    }

    func webView(_: WKWebView, didFail _: WKNavigation?, withError error: any Error) {
        self.controller?.errorText = error.localizedDescription
    }
}

private final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "openclawCanvasA2UIAction"
    static let handlerNames = [messageName]

    weak var controller: ScreenController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Self.handlerNames.contains(message.name) else { return }
        guard let controller else { return }

        guard let url = message.webView?.url else { return }
        guard controller.isTrustedCanvasUIURL(url) else { return }

        guard let body = ScreenController.parseA2UIActionBody(message.body) else { return }

        controller.onA2UIAction?(body)
    }
}
