import AppKit
import Foundation
import WebKit

@MainActor
final class DashboardDownloads: NSObject, WKDownloadDelegate {
    private weak var controller: DashboardWindowController?
    private var generation: UInt64 = 0
    private var pending: [ObjectIdentifier: WKNavigationAction] = [:]
    private var active: [ObjectIdentifier: Transfer] = [:]
    private var failureSheets: [NSWindow] = []

    init(controller: DashboardWindowController) {
        self.controller = controller
    }

    func admit(_ action: WKNavigationAction) -> Bool {
        guard let controller, controller.canDownloadAttachments,
              action.sourceFrame.isMainFrame,
              DashboardWindowController.isTrustedLinkSource(
                  action.sourceFrame.request.url, dashboardURL: controller.currentURL),
              let scheme = action.request.url?.scheme?.lowercased(),
              ["http", "https", "blob", "data"].contains(scheme)
        else { return false }
        // WebKit returns this action when it becomes a download. Retaining it
        // binds conversion to admission, including while a replacement is queued.
        self.pending[ObjectIdentifier(action)] = action
        return true
    }

    func start(_ download: WKDownload, for action: WKNavigationAction) {
        guard self.pending.removeValue(forKey: ObjectIdentifier(action)) != nil,
              let controller, controller.canDownloadAttachments,
              download.webView === controller.webView, let window = controller.window
        else {
            download.cancel { _ in }
            return
        }
        self.active[ObjectIdentifier(download)] = Transfer(
            download: download, window: window, generation: self.generation)
        download.delegate = self
    }

    func retire() {
        self.generation &+= 1
        self.pending.removeAll()
        let transfers = Array(self.active.values)
        self.active.removeAll()
        for transfer in transfers {
            transfer.cancel()
        }
        // Gateway replacement reuses this window; terminal error sheets must
        // retire with their originating document just like pending Save panels.
        let sheets = self.failureSheets
        self.failureSheets.removeAll()
        for sheet in sheets {
            sheet.sheetParent?.endSheet(sheet)
            sheet.orderOut(nil)
        }
    }

    private func isCurrent(_ transfer: Transfer) -> Bool {
        guard let controller else { return false }
        return transfer.generation == self.generation && controller.window === transfer.window &&
            controller.canDownloadAttachments
    }

    private func currentTransfer(_ download: WKDownload) -> Transfer? {
        guard let transfer = self.active[ObjectIdentifier(download)] else { return nil }
        guard self.isCurrent(transfer) else {
            self.cancel(transfer)
            return nil
        }
        return transfer
    }

    private func cancel(_ transfer: Transfer) {
        self.active.removeValue(forKey: ObjectIdentifier(transfer.download))
        transfer.cancel()
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing _: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor @Sendable (URL?) -> Void)
    {
        guard let transfer = self.currentTransfer(download) else {
            completionHandler(nil)
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        transfer.panel = panel
        transfer.destinationCompletion = completionHandler
        panel.beginSheetModal(for: transfer.window) { [weak self] response in
            transfer.panel = nil
            panel.orderOut(nil)
            guard let self, self.active[ObjectIdentifier(download)] === transfer,
                  self.isCurrent(transfer), response == .OK, let destination = panel.url
            else {
                if let self { self.cancel(transfer) } else { transfer.cancel() }
                return
            }
            do {
                let replaceExisting = FileManager.default.fileExists(atPath: destination.path)
                // WebKit requires a nonexistent file. Stage on the destination's
                // volume so cancellation never truncates an existing saved file.
                let directory = try FileManager.default.url(
                    for: .itemReplacementDirectory,
                    in: .userDomainMask,
                    appropriateFor: destination,
                    create: true)
                transfer.stagingDirectory = directory
                let staged = directory.appendingPathComponent(destination.lastPathComponent)
                transfer.destination = (destination, staged, replaceExisting)
                transfer.respond(with: staged)
            } catch {
                self.showFailure(error, for: transfer)
                self.cancel(transfer)
            }
        }
    }

    func download(
        _ download: WKDownload,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest request: URLRequest,
        decisionHandler: @escaping @MainActor @Sendable (WKDownload.RedirectPolicy) -> Void)
    {
        guard self.currentTransfer(download) != nil,
              let scheme = request.url?.scheme?.lowercased(), ["http", "https"].contains(scheme)
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func download(
        _ download: WKDownload,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard self.currentTransfer(download) != nil, let controller else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // The existing owner applies Gateway trust only to its configured
        // authority; external attachments keep ordinary WebKit authentication.
        controller.webView(controller.webView, didReceive: challenge, completionHandler: completionHandler)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let transfer = self.active.removeValue(forKey: ObjectIdentifier(download)) else { return }
        defer { transfer.removeStaging() }
        guard self.isCurrent(transfer), let destination = transfer.destination else { return }
        do {
            // A file created during the transfer was not approved for overwrite.
            if destination.replaceExisting {
                _ = try FileManager.default.replaceItemAt(
                    destination.final,
                    withItemAt: destination.staged,
                    options: .usingNewMetadataOnly)
            } else {
                try FileManager.default.moveItem(at: destination.staged, to: destination.final)
            }
            NSWorkspace.shared.activateFileViewerSelecting([destination.final])
        } catch {
            self.showFailure(error, for: transfer)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData _: Data?) {
        guard let transfer = self.active.removeValue(forKey: ObjectIdentifier(download)) else { return }
        transfer.cancel()
        guard (error as NSError).domain != NSURLErrorDomain || (error as NSError).code != NSURLErrorCancelled else {
            return
        }
        self.showFailure(error, for: transfer)
    }

    private func showFailure(_ error: Error, for transfer: Transfer) {
        guard self.isCurrent(transfer) else { return }
        let alert = NSAlert(error: error)
        alert.messageText = "Attachment download failed"
        alert.informativeText = "\(error.localizedDescription)\n\nTry downloading the attachment again."
        let sheet = alert.window
        self.failureSheets.append(sheet)
        alert.beginSheetModal(for: transfer.window) { [weak self] _ in
            self?.failureSheets.removeAll { $0 === sheet }
        }
    }

    @MainActor
    private final class Transfer {
        let download: WKDownload
        let window: NSWindow
        let generation: UInt64
        var panel: NSSavePanel?
        var destinationCompletion: (@MainActor @Sendable (URL?) -> Void)?
        var destination: (final: URL, staged: URL, replaceExisting: Bool)?
        var stagingDirectory: URL?
        private var cancelled = false

        init(download: WKDownload, window: NSWindow, generation: UInt64) {
            self.download = download
            self.window = window
            self.generation = generation
        }

        func respond(with url: URL?) {
            let completion = self.destinationCompletion
            self.destinationCompletion = nil
            completion?(url)
        }

        func cancel() {
            guard !self.cancelled else { return }
            self.cancelled = true
            let panel = self.panel
            self.panel = nil
            self.respond(with: nil)
            panel?.cancel(nil)
            // A late finish callback can still arrive after cancellation. The
            // owner has already retired us; release staging only after WebKit stops.
            self.download.cancel { [self] _ in self.removeStaging() }
        }

        func removeStaging() {
            guard let directory = self.stagingDirectory else { return }
            self.stagingDirectory = nil
            do {
                try FileManager.default.removeItem(at: directory)
            } catch {
                dashboardWindowLogger
                    .error("dashboard download cleanup failed: \(error.localizedDescription, privacy: .private)")
            }
        }
    }
}
