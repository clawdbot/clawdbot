import Foundation
import SwiftUI

struct LicenseDocument: Identifiable {
    let id: String
    let title: String
    let filename: String
    let body: String
}

enum LicenseDocumentLoader {
    static let directoryName = "Licenses"

    static func bundledDocuments(bundle: Bundle = .main) -> [LicenseDocument] {
        guard let resourceURL = bundle.resourceURL else { return [] }
        return self.documents(in: resourceURL.appendingPathComponent(self.directoryName, isDirectory: true))
    }

    static func documents(in directoryURL: URL) -> [LicenseDocument] {
        let fileManager = FileManager.default
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles])
        else {
            return []
        }

        return urls.compactMap(self.document(from:)).sorted { lhs, rhs in
            let titleComparison = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
            if titleComparison == .orderedSame {
                return lhs.filename.localizedCaseInsensitiveCompare(rhs.filename) == .orderedAscending
            }
            return titleComparison == .orderedAscending
        }
    }

    static func title(from filename: String) -> String {
        let name = URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent
        let title = name
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        return title.isEmpty ? filename : title
    }

    private static func document(from url: URL) -> LicenseDocument? {
        let filename = url.lastPathComponent
        guard !filename.hasPrefix("."),
              url.pathExtension.lowercased() == "txt"
        else {
            return nil
        }

        let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
        guard values?.isRegularFile == true else { return nil }
        guard let body = try? String(contentsOf: url, encoding: .utf8),
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }

        return LicenseDocument(
            id: filename,
            title: self.title(from: filename),
            filename: filename,
            body: body)
    }
}

struct LicenseDocumentDetailView: View {
    let document: LicenseDocument

    var body: some View {
        ScrollView {
            Text(verbatim: self.document.body)
                .font(OpenClawType.monoFootnote)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .accessibilityIdentifier("licenses-detail-text")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(OpenClawProMetric.pagePadding)
        }
        .background(OpenClawProBackground())
        .navigationTitle(self.document.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
