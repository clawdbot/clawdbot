import SwiftUI
import UIKit

struct ChatTranscriptShareSheet: UIViewControllerRepresentable {
    let fileURL: URL

    func makeUIViewController(context _: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [self.fileURL], applicationActivities: nil)
    }

    func updateUIViewController(_: UIActivityViewController, context _: Context) {}
}
