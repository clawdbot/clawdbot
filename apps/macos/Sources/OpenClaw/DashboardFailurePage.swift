import Foundation

/// Renders the static error page the dashboard window shows when the Control
/// UI cannot load. Presentation-only; kept out of `DashboardWindowController`
/// so the controller stays focused on window/navigation behavior.
enum DashboardFailurePage {
    static func html(title: String, message: String, detail: String?, url: URL?) -> String {
        let knownURLs = url.map { [$0] } ?? []
        let safeTitle = self.redactingURLFragments(in: title, knownURLs: knownURLs)
        let safeMessage = self.redactingURLFragments(in: message, knownURLs: knownURLs)
        let safeDetail = detail.map {
            self.redactingURLFragments(in: $0, knownURLs: knownURLs)
        }
        let detailHTML = safeDetail.map { "<p class=\"detail\">\(self.htmlEscape($0))</p>" } ?? ""
        let urlHTML = url.map {
            "<code>\(self.htmlEscape(dashboardLogString(for: $0)))</code>"
        } ?? ""
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            :root { color-scheme: light dark; }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: #101114;
              color: rgba(255,255,255,.92);
              font: 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
            }
            main {
              width: min(540px, calc(100vw - 72px));
              padding: 34px;
              border: 1px solid rgba(255,255,255,.12);
              border-radius: 22px;
              background: rgba(255,255,255,.035);
              box-shadow: 0 28px 90px rgba(0,0,0,.36);
              line-height: 1.45;
            }
            .badge {
              width: 44px;
              height: 44px;
              display: grid;
              place-items: center;
              margin-bottom: 20px;
              border-radius: 14px;
              background: rgba(255,255,255,.07);
              color: #ff746b;
              font-size: 24px;
            }
            h1 {
              margin: 0 0 12px;
              font-size: 24px;
              line-height: 1.16;
              font-weight: 700;
              letter-spacing: 0;
            }
            p {
              margin: 0;
              color: rgba(255,255,255,.76);
              font-size: 16px;
            }
            .detail {
              margin-top: 14px;
              color: rgba(255,255,255,.56);
              font-size: 13px;
            }
            code {
              display: block;
              margin-top: 18px;
              padding: 12px;
              border: 1px solid rgba(255,255,255,.08);
              border-radius: 10px;
              background: rgba(0,0,0,.26);
              color: rgba(255,255,255,.76);
              overflow-wrap: anywhere;
              font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            @media (prefers-color-scheme: light) {
              body { background: #f5f6f8; color: rgba(0,0,0,.86); }
              main {
                background: rgba(255,255,255,.84);
                border-color: rgba(0,0,0,.1);
                box-shadow: 0 28px 90px rgba(0,0,0,.12);
              }
              .badge { background: rgba(0,0,0,.06); }
              p { color: rgba(0,0,0,.68); }
              .detail { color: rgba(0,0,0,.54); }
              code {
                background: rgba(0,0,0,.05);
                border-color: rgba(0,0,0,.08);
                color: rgba(0,0,0,.68);
              }
            }
          </style>
        </head>
        <body>
          <main>
            <div class="badge">!</div>
            <h1>\(self.htmlEscape(safeTitle))</h1>
            <p>\(self.htmlEscape(safeMessage))</p>
            \(detailHTML)
            \(urlHTML)
          </main>
        </body>
        </html>
        """
    }

    static func redactingURLFragments(
        in value: String,
        knownURLs: [URL] = []) -> String
    {
        let knownRedacted = knownURLs.reduce(value) { result, url in
            result.replacingOccurrences(
                of: url.absoluteString,
                with: dashboardLogString(for: url))
        }
        guard let detector = try? NSDataDetector(
            types: NSTextCheckingResult.CheckingType.link.rawValue)
        else {
            return knownRedacted
        }

        let detectorRange = NSRange(
            knownRedacted.startIndex..<knownRedacted.endIndex,
            in: knownRedacted)
        return detector.matches(in: knownRedacted, options: [], range: detectorRange)
            .reversed()
            .reduce(knownRedacted) { result, match in
                guard let url = match.url,
                      url.fragment != nil,
                      let range = Range(match.range, in: result)
                else {
                    return result
                }
                return result.replacingCharacters(
                    in: range,
                    with: dashboardLogString(for: url))
            }
    }

    private static func htmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
