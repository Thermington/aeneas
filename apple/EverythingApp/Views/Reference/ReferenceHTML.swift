import SwiftUI
import EACore

/// The reader's colors and text size, as CSS values. Only `#rrggbb` colors and a number reach the page.
struct ReferenceStyle: Equatable {
    var background: String
    var text: String
    var muted: String
    var accent: String
    var rule: String
    var panel: String
    var dark: Bool
    /// The body text size in CSS pixels.
    var fontSize: Double

    /// From the app theme when one is set, else the system's light or dark look.
    static func make(theme: ThemeColors?, scheme: ColorScheme, base: Double, scale: Double) -> ReferenceStyle {
        let size = (base * scale * 10).rounded() / 10
        if let t = theme?.spec, let bg = FeelTheme.rgb(t.background), let fg = FeelTheme.rgb(t.text) {
            let accent = FeelTheme.rgb(t.accent) ?? (t.isDark ? (0.47, 0.65, 0.91) : (0.16, 0.42, 0.76))
            let panel = FeelTheme.rgb(t.surface) ?? mix(fg, bg, 0.06)
            return ReferenceStyle(background: hex(bg), text: hex(fg), muted: hex(mix(fg, bg, 0.62)), accent: hex(accent),
                                  rule: hex(mix(fg, bg, 0.18)), panel: hex(panel), dark: t.isDark, fontSize: size)
        }
        if scheme == .dark {
            #if os(macOS)
            let bg = "#1E1E1E", panel = "#2A2A2C"
            #else
            let bg = "#000000", panel = "#1C1C1E"
            #endif
            return ReferenceStyle(background: bg, text: "#E8E8ED", muted: "#9D9DA3", accent: "#78A6E8", rule: "#3A3A3C", panel: panel, dark: true, fontSize: size)
        }
        return ReferenceStyle(background: "#FFFFFF", text: "#1C1C1E", muted: "#6C6C70", accent: "#296BC2", rule: "#D8D8DC", panel: "#F2F2F7", dark: false, fontSize: size)
    }

    /// The CSS custom properties the page reads.
    var variables: [String: String] {
        ["--bg": background, "--fg": text, "--muted": muted, "--accent": accent, "--rule": rule, "--panel": panel,
         "--font-size": String(format: "%.1fpx", fontSize), "color-scheme": dark ? "dark" : "light"]
    }

    private typealias RGB = (r: Double, g: Double, b: Double)
    /// `share` of `a` over `b`.
    private static func mix(_ a: RGB, _ b: RGB, _ share: Double) -> RGB {
        (a.r * share + b.r * (1 - share), a.g * share + b.g * (1 - share), a.b * share + b.b * (1 - share))
    }
    private static func hex(_ c: RGB) -> String { FeelTheme.hex(r: c.r, g: c.g, b: c.b) }
}

/// The page the reader shows: the hub's sanitized article inside our own template, styles and policy. The page runs
/// no script of its own (JavaScript from the page is off, and the policy allows none); the app's own script runs in a
/// separate world for positions, sections, pictures and links.
enum ReferenceHTML {
    /// The scheme pictures load through, served by the app with the device's key; nothing else loads.
    static let scheme = "aeneas-ref"
    /// The page's own address: in-book links (`#/reference/...`) resolve against it.
    static let pageURL = URL(string: "\(scheme)://page/")!

    static func page(_ a: ReferenceArticle, sourceTitle: String, languageTag: String, style: ReferenceStyle) -> String {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let rtl = !languageTag.isEmpty && Locale.Language(identifier: languageTag).characterDirection == .rightToLeft
        let kicker = [sourceTitle, a.date.isEmpty ? nil : "offline copy of \(ReferenceText.archiveDate(a.date))"].compactMap { $0 }.joined(separator: ", ")
        let license = a.license.trimmingCharacters(in: .whitespacesAndNewlines)
        let vars = style.variables.sorted { $0.key < $1.key }.filter { $0.key.hasPrefix("--") }.map { "\($0.key): \($0.value);" }.joined(separator: " ")
        return """
        <!doctype html>
        <html lang="\(escape(languageTag))"\(rtl ? " dir=\"rtl\"" : "")>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \(scheme):; style-src 'nonce-\(nonce)'; script-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
        <meta name="referrer" content="no-referrer">
        <style nonce="\(nonce)">:root { \(vars) color-scheme: \(style.dark ? "dark" : "light"); }
        \(css)</style>
        </head>
        <body data-book="\(escape(a.book))">
        <main>
        <header class="ea-head"><p class="ea-kicker">\(escape(kicker))</p><h1>\(escape(a.title))</h1></header>
        <article>
        \(a.html)
        </article>
        \(license.isEmpty ? "" : "<footer class=\"ea-foot\">\(escape(sourceTitle)), \(escape(license)).</footer>")
        </main>
        </body>
        </html>
        """
    }

    /// One picture, enlarged: zoom with two fingers (iPhone, iPad) or a pinch on the trackpad (Mac).
    static func picture(book: String, path: String, alt: String, style: ReferenceStyle) -> String {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let src = mediaURL(book: book, path: path)
        return """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=8, user-scalable=yes">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \(scheme):; style-src 'nonce-\(nonce)'; script-src 'none'; base-uri 'none'; form-action 'none'">
        <style nonce="\(nonce)">
        html, body { margin: 0; height: 100%; background: \(style.background); color: \(style.text); }
        body { display: flex; align-items: center; justify-content: center; }
        img { max-width: 100%; max-height: 100vh; object-fit: contain; }
        </style>
        </head>
        <body><img src="\(escape(src))" alt="\(escape(alt))"></body>
        </html>
        """
    }

    /// The address a picture of a book loads from.
    static func mediaURL(book: String, path: String) -> String {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "media"
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "book", value: book), URLQueryItem(name: "path", value: path)]
        return c.url?.absoluteString ?? "\(scheme)://media/"
    }

    /// The book and path a picture address names.
    static func mediaRequest(_ url: URL) -> (book: String, path: String)? {
        guard url.scheme == scheme, url.host == "media", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let book = items.first(where: { $0.name == "book" })?.value, let path = items.first(where: { $0.name == "path" })?.value,
              !book.isEmpty, !path.isEmpty else { return nil }
        return (book, path)
    }

    static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// System fonts at the reader's size, a comfortable line length, tables and code that scroll sideways.
    static let css = """
    html { background: var(--bg); color: var(--fg); font-family: -apple-system, system-ui, sans-serif; font-size: var(--font-size); line-height: 1.6; -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; }
    body { margin: 0; padding: 4px 20px 56px; overflow-wrap: break-word; }
    main { max-width: 40em; margin: 0 auto; }
    .ea-head { padding-top: 10px; }
    .ea-kicker { color: var(--muted); font-size: 0.8em; margin: 0 0 4px; }
    h1 { font-size: 1.85em; line-height: 1.15; margin: 0 0 0.7em; font-weight: 700; letter-spacing: -0.01em; }
    h2 { font-size: 1.4em; line-height: 1.25; margin: 1.7em 0 0.55em; padding-bottom: 0.25em; border-bottom: 1px solid var(--rule); font-weight: 650; }
    h3 { font-size: 1.15em; line-height: 1.3; margin: 1.4em 0 0.45em; font-weight: 650; }
    h4, h5, h6 { font-size: 1em; margin: 1.2em 0 0.35em; font-weight: 650; }
    h2, h3, h4 { scroll-margin-top: 14px; }
    p { margin: 0 0 0.95em; }
    article { hyphens: auto; -webkit-hyphens: auto; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    a[data-external]::after { content: "\\2197"; font-size: 0.72em; margin-inline-start: 0.12em; opacity: 0.8; }
    img { max-width: 100%; height: auto; border-radius: 4px; cursor: zoom-in; }
    img[data-media]:not([src]) { background: var(--panel); min-height: 1.5em; }
    figure { margin: 1.2em 0; }
    figcaption, .thumbcaption { color: var(--muted); font-size: 0.85em; line-height: 1.45; margin-top: 0.4em; }
    table { display: block; overflow-x: auto; max-width: 100%; width: max-content; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; line-height: 1.45; }
    th, td { border: 1px solid var(--rule); padding: 0.35em 0.6em; vertical-align: top; text-align: start; }
    th { background: var(--panel); font-weight: 600; }
    caption { color: var(--muted); font-size: 0.9em; padding: 0.3em 0; text-align: start; }
    pre { overflow-x: auto; background: var(--panel); padding: 0.8em 0.9em; border-radius: 8px; font-size: 0.85em; line-height: 1.45; }
    code, pre, kbd, samp, tt { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    :not(pre) > code, kbd { background: var(--panel); padding: 0.08em 0.3em; border-radius: 4px; font-size: 0.88em; }
    blockquote { margin: 1em 0; padding-inline-start: 1em; border-inline-start: 3px solid var(--rule); color: var(--muted); }
    ul, ol { padding-inline-start: 1.5em; margin: 0 0 0.95em; }
    li { margin: 0.25em 0; }
    dl { margin: 0 0 0.95em; } dt { font-weight: 600; } dd { margin-inline-start: 1.2em; margin-bottom: 0.4em; }
    hr { border: 0; border-top: 1px solid var(--rule); margin: 1.6em 0; }
    sup, sub { line-height: 0; }
    abbr[title] { text-decoration: underline dotted; }
    ::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
    .mw-editsection, .noprint, .navbox, .vertical-navbox, .mw-empty-elt, .mw-jump-link, [hidden] { display: none !important; }
    .ea-foot { color: var(--muted); font-size: 0.8em; border-top: 1px solid var(--rule); margin-top: 2.4em; padding-top: 0.8em; }
    @media (min-width: 900px) {
      .infobox, table.infobox { float: right; clear: right; margin: 0 0 1em 1.5em; max-width: 22em; }
      [dir="rtl"] .infobox, [dir="rtl"] table.infobox { float: left; margin: 0 1.5em 1em 0; }
    }
    """

    /// The app's own script, in its own world (never the page's): pictures as they near the screen, picture taps,
    /// the section in view, where the page was left, and the commands the app sends.
    static let script = """
    (() => {
      const post = (m) => { try { window.webkit.messageHandlers.ea.postMessage(m); } catch (e) {} };
      const body = document.body;
      if (!body || window.eaReference) return;
      const book = body.getAttribute("data-book") || "";
      const scheme = "\(scheme)";
      const mediaURL = (p) => scheme + "://media/?book=" + encodeURIComponent(book) + "&path=" + encodeURIComponent(p);

      const load = (img) => {
        const p = img.getAttribute("data-media");
        if (p && !img.getAttribute("src")) img.setAttribute("src", mediaURL(p));
      };
      const pictures = Array.from(document.querySelectorAll("img[data-media]"));
      if ("IntersectionObserver" in window) {
        const seen = new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting) { load(e.target); seen.unobserve(e.target); }
        }, { rootMargin: "900px 0px" });
        pictures.forEach((i) => seen.observe(i));
      } else {
        pictures.forEach(load);
      }

      const linkInfo = (a) => {
        const r = a.getBoundingClientRect();
        return { href: a.getAttribute("href") || "", book: a.getAttribute("data-book") || "", path: a.getAttribute("data-path") || "",
                 external: a.hasAttribute("data-external"), text: (a.textContent || "").trim().slice(0, 200),
                 x: r.left, y: r.top, w: r.width, h: r.height };
      };

      document.addEventListener("click", (ev) => {
        const img = ev.target.closest ? ev.target.closest("img[data-media]") : null;
        if (img) {
          ev.preventDefault();
          ev.stopPropagation();
          post({ type: "image", path: img.getAttribute("data-media") || "", alt: img.getAttribute("alt") || "" });
        }
      }, true);
      document.addEventListener("contextmenu", (ev) => {
        const a = ev.target.closest ? ev.target.closest("a[href]") : null;
        post({ type: "context", link: a ? linkInfo(a) : null });
      }, true);
      document.addEventListener("mouseover", (ev) => {
        const a = ev.target.closest ? ev.target.closest("a[href]") : null;
        if (a) post({ type: "hover", link: linkInfo(a) });
      }, true);
      document.addEventListener("mouseout", (ev) => {
        const a = ev.target.closest ? ev.target.closest("a[href]") : null;
        const to = ev.relatedTarget && ev.relatedTarget.closest ? ev.relatedTarget.closest("a[href]") : null;
        if (a && a !== to) post({ type: "hover", link: null });
      }, true);
      // A link inside the book that changed the address instead of being stopped by the app.
      window.addEventListener("hashchange", () => {
        if (location.hash.indexOf("#/reference/") === 0) {
          post({ type: "link", href: location.hash });
          try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
        }
      });

      const heads = Array.from(document.querySelectorAll("article h2[id], article h3[id]"));
      let current = null;
      const section = () => {
        const line = window.innerHeight * 0.25;
        let id = "";
        for (const h of heads) { if (h.getBoundingClientRect().top <= line) id = h.id; else break; }
        if (id !== current) { current = id; post({ type: "section", id }); }
      };
      const position = () => {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const y = window.scrollY;
        let anchor = "", offset = 0;
        // A heading just jumped to sits its scroll margin below the top; it still counts as the one in view.
        for (const h of heads) {
          const top = h.getBoundingClientRect().top + y;
          if (top <= y + 24) { anchor = h.id; offset = y - top; } else break;
        }
        post({ type: "position", fraction: Math.min(1, Math.max(0, y / max)), anchor, offset });
      };
      let ticking = false, timer = null;
      window.addEventListener("scroll", () => {
        if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; section(); }); }
        clearTimeout(timer);
        timer = setTimeout(position, 400);
      }, { passive: true });

      window.eaReference = {
        scrollTo(id) {
          if (!id) { window.scrollTo(0, 0); section(); return; }
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ block: "start" });
          section();
        },
        restore(fraction, anchor, offset) {
          let y = null;
          if (anchor) {
            const h = document.getElementById(anchor);
            if (h) y = h.getBoundingClientRect().top + window.scrollY + offset;
          }
          if (y === null) y = fraction * Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo(0, Math.max(0, y));
          section();
        },
        style(vars) {
          for (const k of Object.keys(vars)) {
            if (k === "color-scheme") document.documentElement.style.colorScheme = vars[k];
            else document.documentElement.style.setProperty(k, vars[k]);
          }
        },
        count(q) {
          if (!q) return 0;
          const text = (document.body.innerText || "").toLocaleLowerCase();
          const needle = q.toLocaleLowerCase();
          let n = 0, i = 0;
          while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
          return n;
        },
        linkAt(x, y) {
          const el = document.elementFromPoint(x, y);
          const a = el && el.closest ? el.closest("a[href]") : null;
          return a ? linkInfo(a) : null;
        }
      };
      section();
    })();
    """
}
