import OpenClawKit
import SwiftUI
import VisionKit

struct QRScannerView: UIViewControllerRepresentable {
    let onGatewayLink: (GatewayConnectDeepLink) -> Void
    let onError: (String) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        guard DataScannerViewController.isSupported else {
            context.coordinator.reportError("QR scanning is not supported on this device.")
            return UIViewController()
        }
        guard DataScannerViewController.isAvailable else {
            context.coordinator.reportError("Camera scanning is currently unavailable.")
            return UIViewController()
        }
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do {
            try scanner.startScanning()
        } catch {
            context.coordinator.reportError("Could not start QR scanner.")
        }
        return scanner
    }

    func updateUIViewController(_: UIViewController, context _: Context) {}

    static func dismantleUIViewController(_ uiViewController: UIViewController, coordinator: Coordinator) {
        if let scanner = uiViewController as? DataScannerViewController {
            scanner.stopScanning()
        }
        coordinator.parent.onDismiss()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: QRScannerView
        private var handled = false
        private var reportedError = false

        init(parent: QRScannerView) {
            self.parent = parent
        }

        func reportError(_ message: String) {
            guard !self.reportedError else { return }
            self.reportedError = true
            Task { @MainActor in
                self.parent.onError(message)
            }
        }

        func dataScanner(_: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
            guard !self.handled else { return }
            for item in items {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue
                else { continue }

                if let link = GatewayConnectDeepLink.fromSetupInput(payload) {
                    self.handled = true
                    Task { @MainActor in
                        self.parent.onGatewayLink(link)
                    }
                    return
                }
            }
        }

        func dataScanner(_: DataScannerViewController, didRemove _: [RecognizedItem], allItems _: [RecognizedItem]) {}

        func dataScanner(
            _: DataScannerViewController,
            becameUnavailableWithError _: DataScannerViewController.ScanningUnavailable)
        {
            self.reportError("Camera is not available on this device.")
        }
    }
}
