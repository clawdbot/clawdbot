import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import WebKit

@MainActor
final class CanvasWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let sessionKey: String
    private let root: URL
    private let sessionDir: URL
    private let schemeHandler: CanvasSchemeHandler
    let webView: WKWebView
    private var a2uiActionMessageHandler: CanvasA2UIActionMessageHandler?
    private let watcher: CanvasFileWatcher
    private let container: HoverChromeContainerView
    let presentation: CanvasPresentation
    var preferredPlacement: CanvasPlacement?
    private(set) var currentTarget: String?
    private var debugStatusEnabled = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?

    var onVisibilityChanged: ((Bool) -> Void)?

    init(sessionKey: String, root: URL, presentation: CanvasPresentation) throws {
        self.sessionKey = sessionKey
        self.root = root
        self.presentation = presentation

        canvasWindowLogger.debug("CanvasWindowController init start session=\(sessionKey, privacy: .public)")
        let safeSessionKey = CanvasWindowController.sanitizeSessionKey(sessionKey)
        canvasWindowLogger.debug("CanvasWindowController init sanitized session=\(safeSessionKey, privacy: .public)")
        self.sessionDir = root.appendingPathComponent(safeSessionKey, isDirectory: true)
        try FileManager().createDirectory(at: self.sessionDir, withIntermediateDirectories: true)
        canvasWindowLogger.debug("CanvasWindowController init session dir ready")

        self.schemeHandler = CanvasSchemeHandler(root: root)
        canvasWindowLogger.debug("CanvasWindowController init scheme handler ready")

        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        canvasWindowLogger.debug("CanvasWindowController init config ready")
        for scheme in CanvasScheme.allSchemes {
            config.setURLSchemeHandler(self.schemeHandler, forURLScheme: scheme)
        }
        canvasWindowLogger.debug("CanvasWindowController init scheme handler installed")

        // Bridge A2UI "a2uiaction" DOM events back into the native agent loop.
        //
        // This fallback event bridge runs only on the app-owned scheme. The
        // script-message handler separately gates hosted A2UI to its exact URL.
        canvasWindowLogger.debug("CanvasWindowController init building A2UI bridge script")
        let injectedSessionKey = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "main"
        let allowedSchemesJSON = (
            try? String(
                data: JSONSerialization.data(withJSONObject: CanvasScheme.allSchemes),
                encoding: .utf8)) ?? "[]"
        let bridgeScript = """
        (() => {
          try {
            const allowedSchemes = \(allowedSchemesJSON);
            const protocol = location.protocol.replace(':', '');
            if (!allowedSchemes.includes(protocol)) return;
            if (globalThis.__openclawA2UIBridgeInstalled) return;
            globalThis.__openclawA2UIBridgeInstalled = true;

            const sessionKey = \(Self.jsStringLiteral(injectedSessionKey));
            const machineName = \(Self.jsStringLiteral(InstanceIdentity.displayName));
            const instanceId = \(Self.jsStringLiteral(InstanceIdentity.instanceId));

            globalThis.addEventListener('a2uiaction', (evt) => {
              try {
                const payload = evt?.detail ?? evt?.payload ?? null;
                if (!payload || payload.eventType !== 'a2ui.action') return;

                const action = payload.action ?? null;
                const name = action?.name ?? '';
                if (!name) return;

                const context = Array.isArray(action?.context) ? action.context : [];
                const userAction = {
                  name,
                  surfaceId: payload.surfaceId ?? 'main',
                  sourceComponentId: payload.sourceComponentId ?? '',
                  dataContextPath: payload.dataContextPath ?? '',
                  timestamp: new Date().toISOString(),
                  ...(context.length ? { context } : {}),
                };

                const handler = globalThis.webkit?.messageHandlers?.openclawCanvasA2UIAction;

                // If the bundled A2UI shell is present, let it forward actions so we keep its richer
                // context resolution (data model path lookups, surface detection, etc.).
                const hasBundledA2UIHost =
                  !!globalThis.openclawA2UI ||
                  !!document.querySelector('openclaw-a2ui-host');
                if (hasBundledA2UIHost && handler?.postMessage) return;

                // Otherwise, forward directly when possible.
                if (!hasBundledA2UIHost && handler?.postMessage) {
                  handler.postMessage({ userAction });
                  return;
                }

                // Without the native handler, fail closed instead of exposing an
                // unattended deep-link credential to page JavaScript.
              } catch {}
            }, true);
          } catch {}
        })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        canvasWindowLogger.debug("CanvasWindowController init A2UI bridge installed")

        canvasWindowLogger.debug("CanvasWindowController init creating WKWebView")
        self.webView = WKWebView(frame: .zero, configuration: config)
        // Canvas scaffold is a fully self-contained HTML page; avoid relying on transparency underlays.
        self.webView.setValue(true, forKey: "drawsBackground")

        let sessionDir = self.sessionDir
        let webView = self.webView
        self.watcher = CanvasFileWatcher(url: sessionDir) { [weak webView] in
            Task { @MainActor in
                guard let webView else { return }

                // Only auto-reload when we are showing local canvas content.
                guard let scheme = webView.url?.scheme,
                      CanvasScheme.allSchemes.contains(scheme) else { return }

                let path = webView.url?.path ?? ""
                if path == "/" || path.isEmpty {
                    let indexA = sessionDir.appendingPathComponent("index.html", isDirectory: false)
                    let indexB = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
                    if !FileManager().fileExists(atPath: indexA.path),
                       !FileManager().fileExists(atPath: indexB.path)
                    {
                        return
                    }
                }

                webView.reload()
            }
        }

        self.container = HoverChromeContainerView(containing: self.webView)
        let window = Self.makeWindow(for: presentation, contentView: self.container)
        canvasWindowLogger.debug("CanvasWindowController init makeWindow done")
        super.init(window: window)

        let handler = CanvasA2UIActionMessageHandler(sessionKey: sessionKey)
        self.a2uiActionMessageHandler = handler
        for name in CanvasA2UIActionMessageHandler.allMessageNames {
            self.webView.configuration.userContentController.add(handler, name: name)
        }

        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
        self.window?.delegate = self
        self.container.onClose = { [weak self] in
            self?.hideCanvas()
        }

        self.watcher.start()
        canvasWindowLogger.debug("CanvasWindowController init done")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @MainActor deinit {
        for name in CanvasA2UIActionMessageHandler.allMessageNames {
            self.webView.configuration.userContentController.removeScriptMessageHandler(forName: name)
        }
        self.watcher.stop()
    }

    func applyPreferredPlacement(_ placement: CanvasPlacement?) {
        self.preferredPlacement = placement
    }

    func showCanvas(path: String? = nil, trustedA2UIActions: Bool = false) {
        if case let .panel(anchorProvider) = self.presentation {
            self.presentAnchoredPanel(anchorProvider: anchorProvider)
            if let path {
                self.load(target: path, trustedA2UIActions: trustedA2UIActions)
            }
            return
        }

        self.showWindow(nil)
        self.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let path {
            self.load(target: path, trustedA2UIActions: trustedA2UIActions)
        }
        self.onVisibilityChanged?(true)
    }

    func hideCanvas() {
        if case .panel = self.presentation {
            self.persistFrameIfPanel()
        }
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
    }

    func load(target: String, trustedA2UIActions: Bool = false) {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        self.currentTarget = trimmed
        self.a2uiActionMessageHandler?.setTrustedRemoteURL(nil)

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == "https" || scheme == "http" {
                if trustedA2UIActions {
                    self.a2uiActionMessageHandler?.setTrustedRemoteURL(url)
                }
                canvasWindowLogger.debug(
                    "canvas load web scheme=\(scheme, privacy: .public) host=\(url.host ?? "-", privacy: .public)")
                self.webView.load(URLRequest(url: url))
                return
            }
            if scheme == "file" {
                canvasWindowLogger.debug("canvas load file \(url.absoluteString, privacy: .public)")
                self.loadFile(url)
                return
            }
        }

        // Convenience: absolute file paths resolve as local files when they exist.
        // (Avoid treating Canvas routes like "/" as filesystem paths.)
        if trimmed.hasPrefix("/") {
            var isDir: ObjCBool = false
            if FileManager().fileExists(atPath: trimmed, isDirectory: &isDir), !isDir.boolValue {
                let url = URL(fileURLWithPath: trimmed)
                canvasWindowLogger.debug("canvas load file \(url.absoluteString, privacy: .public)")
                self.loadFile(url)
                return
            }
        }

        guard let url = CanvasScheme.makeURL(
            session: CanvasWindowController.sanitizeSessionKey(self.sessionKey),
            path: trimmed)
        else {
            canvasWindowLogger
                .error(
                    "invalid canvas url session=\(self.sessionKey, privacy: .public)")
            return
        }
        canvasWindowLogger.debug("canvas load local canvas")
        self.webView.load(URLRequest(url: url))
    }

    func updateA2UITrustForMainFrameNavigation(to url: URL) {
        self.a2uiActionMessageHandler?.updateTrustForMainFrameNavigation(to: url)
    }

    func updateDebugStatus(enabled: Bool, title: String?, subtitle: String?) {
        self.debugStatusEnabled = enabled
        self.debugStatusTitle = title
        self.debugStatusSubtitle = subtitle
        self.applyDebugStatusIfNeeded()
    }

    func applyDebugStatusIfNeeded() {
        WebViewJavaScriptSupport.applyDebugStatus(
            webView: self.webView,
            enabled: self.debugStatusEnabled,
            title: self.debugStatusTitle,
            subtitle: self.debugStatusSubtitle)
    }

    private func loadFile(_ url: URL) {
        let fileURL = url.isFileURL ? url : URL(fileURLWithPath: url.path)
        let accessDir = fileURL.deletingLastPathComponent()
        self.webView.loadFileURL(fileURL, allowingReadAccessTo: accessDir)
    }

    func eval(javaScript: String) async throws -> String {
        try await WebViewJavaScriptSupport.evaluateToString(webView: self.webView, javaScript: javaScript)
    }

    func snapshot(to outPath: String?) async throws -> String {
        let image: NSImage = try await withCheckedThrowingContinuation { cont in
            self.webView.takeSnapshot(with: nil) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Canvas", code: 11, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot returned nil image",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }

        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else {
            throw NSError(domain: "Canvas", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "failed to encode png",
            ])
        }

        let snapshotID = "\(CanvasWindowController.sanitizeSessionKey(self.sessionKey))-\(UUID().uuidString)"
        let path: String = if let outPath, !outPath.isEmpty {
            outPath
        } else {
            "/tmp/openclaw-canvas-\(snapshotID).png"
        }

        try png.write(to: URL(fileURLWithPath: path), options: [.atomic])
        return path
    }

    var directoryPath: String {
        self.sessionDir.path
    }

    func shouldAutoNavigateToA2UI(lastAutoTarget: String?, candidateTarget: String) -> Bool {
        let current = (self.currentTarget ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = candidateTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        if current.isEmpty || current == "/" { return true }
        if !candidate.isEmpty, current == candidate { return false }
        if let lastAuto = lastAutoTarget?.trimmingCharacters(in: .whitespacesAndNewlines),
           !lastAuto.isEmpty,
           current == lastAuto
        {
            return true
        }
        return false
    }
}
