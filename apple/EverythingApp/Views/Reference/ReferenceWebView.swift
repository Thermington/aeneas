import SwiftUI
import WebKit
import EACore
#if os(macOS)
import AppKit
#endif

/// What the page tells the reader.
enum ReferenceWebEvent {
    /// Laid out and back where it was left.
    case shown
    /// A link inside the book.
    case open(ReferencePageLink)
    /// A link to another site.
    case external(URL)
    /// The heading in view ("" above the first).
    case section(String)
    case position(ReferencePosition)
    case image(path: String, alt: String)
    /// Mac: Force Touch on a link inside the book, or Preview in its right-click menu. The rect is the link's, in the
    /// page view's own points.
    case preview(ReferencePageLink, CGRect)
}

/// Commands for the page on screen: jump to a heading, find, colors and text size.
@MainActor
final class ReferenceWebController: ObservableObject {
    fileprivate weak var webView: WKWebView?

    func scroll(to id: String) { call("window.eaReference.scrollTo(id)", ["id": id]) }

    func apply(_ style: ReferenceStyle) { call("window.eaReference.style(vars)", ["vars": style.variables]) }

    #if os(iOS)
    /// The system's find bar, with its count of matches.
    func showFind() {
        guard let w = webView else { return }
        w.becomeFirstResponder()
        w.findInteraction?.presentFindNavigator(showingReplace: false)
    }
    #endif

    /// How often the words appear on the page.
    func count(_ text: String) async -> Int {
        let r = await value("return window.eaReference.count(q)", ["q": text])
        return (r as? NSNumber)?.intValue ?? 0
    }

    /// Selects and shows the next (or the one before) match; false when there is none.
    func find(_ text: String, backwards: Bool) async -> Bool {
        guard let w = webView, !text.isEmpty else { return false }
        let c = WKFindConfiguration()
        c.backwards = backwards
        c.caseSensitive = false
        c.wraps = true
        return await withCheckedContinuation { cont in
            w.find(text, configuration: c) { result in cont.resume(returning: result.matchFound) }
        }
    }

    fileprivate func call(_ js: String, _ args: [String: Any]) {
        webView?.callAsyncJavaScript(js, arguments: args, in: nil, in: .defaultClient, completionHandler: nil)
    }

    fileprivate func value(_ js: String, _ args: [String: Any]) async -> Any? {
        guard let w = webView else { return nil }
        return await withCheckedContinuation { cont in
            w.callAsyncJavaScript(js, arguments: args, in: nil, in: .defaultClient) { result in
                if case .success(let v) = result { cont.resume(returning: v) } else { cont.resume(returning: nil) }
            }
        }
    }
}

/// The page itself: the hub's sanitized article in our template, with pictures through the app and every link
/// decided by the app.
@MainActor
struct ReferenceWebView {
    var article: ReferenceArticle
    var sourceTitle: String
    var languageTag: String
    var client: HubClient
    var style: ReferenceStyle
    /// Where the page was left on this device, restored once it is laid out.
    var position: ReferencePosition?
    var controller: ReferenceWebController
    var onEvent: (ReferenceWebEvent) -> Void

    func makeCoordinator() -> ReferenceWebCoordinator { ReferenceWebCoordinator(self) }
}

#if os(iOS)
extension ReferenceWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateUIView(_ webView: WKWebView, context: Context) { context.coordinator.update(self, webView) }
    static func dismantleUIView(_ webView: WKWebView, coordinator: ReferenceWebCoordinator) { coordinator.tearDown(webView) }
}
#else
extension ReferenceWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeWebView() }
    func updateNSView(_ webView: WKWebView, context: Context) { context.coordinator.update(self, webView) }
    static func dismantleNSView(_ webView: WKWebView, coordinator: ReferenceWebCoordinator) { coordinator.tearDown(webView) }
}
#endif

/// A link the page described: where it points and where it is on screen.
struct ReferenceLinkInfo {
    var href: String
    var book: String
    var path: String
    var external: Bool
    var text: String
    var rect: CGRect

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let href = d["href"] as? String else { return nil }
        func n(_ k: String) -> CGFloat { CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        self.href = href
        book = d["book"] as? String ?? ""
        path = d["path"] as? String ?? ""
        external = d["external"] as? Bool ?? false
        text = d["text"] as? String ?? ""
        rect = CGRect(x: n("x"), y: n("y"), width: n("w"), height: n("h"))
    }

    /// A page inside the book: from `data-book` and `data-path`, else from the address.
    var page: ReferencePageLink? {
        if !book.isEmpty, !path.isEmpty { return ReferencePageLink(book: book, path: path, title: text) }
        return ReferenceLink.parse(href).map { ReferencePageLink(book: $0.book, path: $0.path, title: text) }
    }

    /// A link to another site.
    var outside: URL? {
        guard let u = URL(string: href), let s = u.scheme?.lowercased(), ["http", "https"].contains(s) else { return nil }
        return u
    }
}

@MainActor
final class ReferenceWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var parent: ReferenceWebView
    private let pictures: ReferenceSchemeHandler
    private var loaded: String?
    private var applied: ReferenceStyle?
    private var ready = false
    /// The latest place the page was left, for a reload after WebKit's page process stopped.
    private var latest: ReferencePosition?
    private var hover: ReferenceLinkInfo?
    private var context: (link: ReferenceLinkInfo?, at: Date)?
    /// A link opened this second: the same tap reported twice opens one page.
    private var lastOpen: (id: String, at: Date)?

    init(_ parent: ReferenceWebView) {
        self.parent = parent
        pictures = ReferenceSchemeHandler(client: parent.client)
        latest = parent.position
    }

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing the page does is kept on disk: no cookies, caches or storage.
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(pictures, forURLScheme: ReferenceHTML.scheme)
        // The page runs no script of its own; the app's script runs in its own world.
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.suppressesIncrementalRendering = true
        #if os(iOS)
        config.dataDetectorTypes = []
        #endif
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: ReferenceHTML.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        content.add(ReferenceScriptProxy(self), contentWorld: .defaultClient, name: "ea")
        config.userContentController = content

        #if os(macOS)
        let web = ReferenceWKWebView(frame: .zero, configuration: config)
        web.host = self
        // Our own previews; WebKit's would load the page behind the link.
        web.allowsLinkPreview = false
        web.allowsMagnification = false
        #else
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.isFindInteractionEnabled = true
        // Long press opens our own menu and preview (webView(_:contextMenuConfigurationFor:)).
        web.allowsLinkPreview = true
        #endif
        web.allowsBackForwardNavigationGestures = false
        #if DEBUG
        web.isInspectable = true
        #endif
        web.navigationDelegate = self
        web.uiDelegate = self
        parent.controller.webView = web
        load(web)
        return web
    }

    func update(_ view: ReferenceWebView, _ web: WKWebView) {
        parent = view
        parent.controller.webView = web
        if loaded != key(view.article) {
            latest = view.position
            load(web)
        } else if ready, applied != view.style {
            applied = view.style
            paint(web, view.style)
            parent.controller.apply(view.style)
        }
    }

    func tearDown(_ web: WKWebView) {
        web.stopLoading()
        web.configuration.userContentController.removeAllScriptMessageHandlers()
        web.navigationDelegate = nil
        web.uiDelegate = nil
        #if os(macOS)
        (web as? ReferenceWKWebView)?.host = nil
        #endif
    }

    private func key(_ a: ReferenceArticle) -> String { ReferenceLink.key(book: a.book, path: a.path) + "\n" + String(a.html.count) }

    private func load(_ web: WKWebView) {
        ready = false
        loaded = key(parent.article)
        applied = parent.style
        paint(web, parent.style)
        let html = ReferenceHTML.page(parent.article, sourceTitle: parent.sourceTitle, languageTag: parent.languageTag, style: parent.style)
        web.loadHTMLString(html, baseURL: ReferenceHTML.pageURL)
    }

    /// What shows past the page's ends when it is pulled further: the page's own color.
    private func paint(_ web: WKWebView, _ style: ReferenceStyle) {
        guard let c = FeelTheme.rgb(style.background) else { return }
        #if os(macOS)
        web.underPageBackgroundColor = NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
        #else
        web.underPageBackgroundColor = UIColor(red: c.r, green: c.g, blue: c.b, alpha: 1)
        #endif
    }

    private func open(_ link: ReferencePageLink) {
        if let l = lastOpen, l.id == link.id, Date().timeIntervalSince(l.at) < 1 { return }
        lastOpen = (link.id, Date())
        parent.onEvent(.open(link))
    }

    // MARK: navigation

    /// Answered at once: a jump inside the page is decided synchronously by WebKit, and a late answer let the address
    /// change before the cancel arrived.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(decide(action))
    }

    private func decide(_ action: WKNavigationAction) -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == ReferenceHTML.scheme {
            if let l = ReferenceLink.parse(url.absoluteString) {
                open(ReferencePageLink(book: l.book, path: l.path))
                return .cancel
            }
            // The page itself, and jumps inside it (a footnote, a heading).
            if url.host == "page", action.targetFrame?.isMainFrame ?? false {
                if url.fragment != nil || action.navigationType == .other || action.navigationType == .reload { return .allow }
            }
            return .cancel
        }
        // Another site: never inside the reader. A tap asks before the browser opens it.
        if action.navigationType == .linkActivated, let s = url.scheme?.lowercased(), ["http", "https"].contains(s) {
            parent.onEvent(.external(url))
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        if applied != parent.style {
            applied = parent.style
            parent.controller.apply(parent.style)
        }
        guard let p = latest, p.fraction > 0 || !p.anchor.isEmpty else { parent.onEvent(.shown); return }
        webView.callAsyncJavaScript("window.eaReference.restore(f, a, o)", arguments: ["f": p.fraction, "a": p.anchor, "o": p.offset],
                                    in: nil, in: .defaultClient) { [weak self] _ in self?.parent.onEvent(.shown) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.onEvent(.shown) }

    /// WebKit's page process stopped (memory pressure): the page loads again where it was left.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load(webView) }

    /// `target="_blank"` and the like: decided as a tap on the link, never a new window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if let l = ReferenceLink.parse(url.absoluteString) { open(ReferencePageLink(book: l.book, path: l.path)) }
            else if let s = url.scheme?.lowercased(), ["http", "https"].contains(s) { parent.onEvent(.external(url)) }
        }
        return nil
    }

    // MARK: the app's script

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "section":
            parent.onEvent(.section(body["id"] as? String ?? ""))
        case "position":
            let p = ReferencePosition(fraction: (body["fraction"] as? NSNumber)?.doubleValue ?? 0, anchor: body["anchor"] as? String ?? "",
                                      offset: (body["offset"] as? NSNumber)?.doubleValue ?? 0)
            latest = p
            parent.onEvent(.position(p))
        case "image":
            if let path = body["path"] as? String, !path.isEmpty { parent.onEvent(.image(path: path, alt: body["alt"] as? String ?? "")) }
        case "link":
            if let href = body["href"] as? String, let l = ReferenceLink.parse(href) { open(ReferencePageLink(book: l.book, path: l.path)) }
        case "context":
            context = (ReferenceLinkInfo(body["link"]), Date())
        case "hover":
            hover = ReferenceLinkInfo(body["link"])
            #if os(macOS)
            // Force Touch on a link inside the book shows our preview, not Look Up.
            (message.webView as? ReferenceWKWebView)?.lookUp(enabled: hover?.page == nil)
            #endif
        default:
            break
        }
    }

    // MARK: iPhone and iPad: long press

    #if os(iOS)
    func webView(_ webView: WKWebView, contextMenuConfigurationFor elementInfo: WKContextMenuElementInfo) async -> UIContextMenuConfiguration? {
        guard let url = elementInfo.linkURL else { return nil }
        if let l = ReferenceLink.parse(url.absoluteString) {
            let link = ReferencePageLink(book: l.book, path: l.path)
            let client = parent.client
            return UIContextMenuConfiguration(identifier: link.id as NSString, previewProvider: {
                let card = UIHostingController(rootView: ReferencePreviewCard(client: client, link: link, onOpen: nil))
                card.sizingOptions = .preferredContentSize
                return card
            }, actionProvider: { [weak self] _ in
                UIMenu(children: [UIAction(title: "Open", image: UIImage(systemName: "doc.text")) { _ in self?.open(link) }])
            })
        }
        guard let s = url.scheme?.lowercased(), ["http", "https"].contains(s) else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(title: url.host ?? "", children: [
                UIAction(title: "Open in Browser", image: UIImage(systemName: "safari")) { _ in self?.parent.onEvent(.external(url)) },
                UIAction(title: "Copy Address", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.url = url },
            ])
        }
    }

    /// A tap on the preview opens the page.
    func webView(_ webView: WKWebView, contextMenuForElement elementInfo: WKContextMenuElementInfo, willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating) {
        guard let url = elementInfo.linkURL, let l = ReferenceLink.parse(url.absoluteString) else { return }
        animator.addCompletion { [weak self] in self?.open(ReferencePageLink(book: l.book, path: l.path)) }
    }
    #endif

    // MARK: Mac: right click and Force Touch

    #if os(macOS)
    /// WebKit's own items that would load a page, a picture or a file outside the reader.
    private static let dropped: Set<String> = [
        "WKMenuItemIdentifierOpenLink", "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage", "WKMenuItemIdentifierCopyImageURL",
        "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierOpenMediaInNewWindow", "WKMenuItemIdentifierDownloadMedia",
        "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
    ]

    fileprivate func adjust(_ menu: NSMenu) {
        let link = context.flatMap { Date().timeIntervalSince($0.at) < 2 ? $0.link : nil }
        context = nil
        var drop = Self.dropped
        if link?.page != nil { drop.insert("WKMenuItemIdentifierCopyLink") }
        for item in menu.items where drop.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
        var ours: [NSMenuItem] = []
        if let link, let page = link.page {
            ours.append(item("Preview", "eye", #selector(previewItem(_:)), link))
            ours.append(item("Open", "doc.text", #selector(openItem(_:)), ReferenceLinkBox(page: page)))
        } else if let link, let url = link.outside {
            ours.append(item("Open in Browser…", "safari", #selector(outsideItem(_:)), url))
        }
        if !ours.isEmpty {
            if !menu.items.isEmpty { ours.append(.separator()) }
            for (i, m) in ours.enumerated() { menu.insertItem(m, at: i) }
        }
        tidySeparators(menu)
    }

    private func item(_ title: String, _ symbol: String, _ action: Selector, _ object: Any) -> NSMenuItem {
        let m = NSMenuItem(title: title, action: action, keyEquivalent: "")
        m.target = self
        m.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        m.representedObject = object
        return m
    }

    private func tidySeparators(_ menu: NSMenu) {
        while let first = menu.items.first, first.isSeparatorItem { menu.removeItem(first) }
        while let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
        var previousWasSeparator = false
        for m in menu.items {
            if m.isSeparatorItem, previousWasSeparator { menu.removeItem(m) } else { previousWasSeparator = m.isSeparatorItem }
        }
    }

    @objc private func previewItem(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? ReferenceLinkBox, let page = box.info?.page else { return }
        parent.onEvent(.preview(page, box.info?.rect ?? .zero))
    }

    @objc private func openItem(_ sender: NSMenuItem) {
        if let page = (sender.representedObject as? ReferenceLinkBox)?.page { open(page) }
    }

    @objc private func outsideItem(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { parent.onEvent(.external(url)) }
    }

    fileprivate func forceClick() {
        guard let h = hover, let page = h.page else { return }
        parent.onEvent(.preview(page, h.rect))
    }

    private func item(_ title: String, _ symbol: String, _ action: Selector, _ link: ReferenceLinkInfo) -> NSMenuItem {
        item(title, symbol, action, ReferenceLinkBox(info: link))
    }
    #endif
}

/// A link carried by a menu item.
final class ReferenceLinkBox: NSObject {
    var info: ReferenceLinkInfo?
    var page: ReferencePageLink?
    init(info: ReferenceLinkInfo) { self.info = info; page = info.page }
    init(page: ReferencePageLink) { self.page = page }
}

/// The message handler, held weakly: WebKit keeps its handlers alive, and the page must not keep the reader alive.
private final class ReferenceScriptProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

/// Pictures of a page: `aeneas-ref://media/?book=&path=` is fetched from the hub with this device's key (any
/// transport the app has), checked to be a picture, and handed to the page. Anything else is refused.
@MainActor
final class ReferenceSchemeHandler: NSObject, WKURLSchemeHandler {
    private let client: HubClient
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(client: HubClient) { self.client = client }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let m = ReferenceHTML.mediaRequest(url) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let key = ObjectIdentifier(task)
        let client = client
        running[key] = Task { [weak self] in
            let data = await ReferenceMediaCache.shared.data(book: m.book, path: m.path, client: client)
            // Stopped meanwhile (the page went): WebKit must not hear from this task again.
            guard let self, self.running.removeValue(forKey: key) != nil else { return }
            guard let data, let type = ReferenceMedia.mimeType(data),
                  let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Type": type, "Content-Length": String(data.count),
                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
                  ]) else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }
}

#if os(macOS)
/// The Mac's page view: our items in the right-click menu, and Force Touch on a link shows its preview.
final class ReferenceWKWebView: WKWebView {
    weak var host: ReferenceWebCoordinator?
    private var forced = false

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        host?.adjust(menu)
    }

    override func pressureChange(with event: NSEvent) {
        super.pressureChange(with: event)
        if event.stage >= 2 {
            if !forced { forced = true; host?.forceClick() }
        } else if event.stage == 0 {
            forced = false
        }
    }

    override func mouseUp(with event: NSEvent) {
        forced = false
        super.mouseUp(with: event)
    }

    /// Look Up (Force Touch on a word) stays on everywhere but over a link inside the book. AppKit's recognizer for it
    /// has no public type, so it is found by its class name; when it is not there, nothing changes.
    func lookUp(enabled: Bool) {
        for r in immediateRecognizers(self) where r.isEnabled != enabled { r.isEnabled = enabled }
    }

    private func immediateRecognizers(_ v: NSView) -> [NSGestureRecognizer] {
        v.gestureRecognizers.filter { NSStringFromClass(type(of: $0)).contains("ImmediateAction") } + v.subviews.flatMap(immediateRecognizers)
    }
}
#endif
