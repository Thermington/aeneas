/**
 * A check on the Windows and Android app's Rust source (web/src-tauri/src/lib.rs), run by windowGuard.test.ts: no window
 * is made where Windows deadlocks. On Windows, WebviewWindowBuilder deadlocks the app's main thread when it is used in a
 * synchronous command or an event handler (Tauri's own note on WebviewWindowBuilder::new, wry issue 583). From
 * 2026-10-28 to 2026-11-16 the Now widget, pop-out windows and Capture were made there: they opened blank, would not
 * close, and closing the app from the taskbar hung it until Windows ended it. No test could see it on a Mac.
 *
 * A window may be made in an `async` command, inside `in_background(...)` (a task of its own), and in the setup hook
 * (`desktop_setup`). Not used by the app itself.
 */

export interface GuardProblem { fn: string; line: number; why: string }

/** Rust with comments and string and char literals blanked to spaces (lines kept), so braces and names in them do not count. */
export function blankRust(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? src.length : e;
      blank(i, end); i = end; continue;
    }
    if (c === "/" && n === "*") {
      let depth = 1, k = i + 2;
      while (k < src.length && depth) {
        if (src[k] === "/" && src[k + 1] === "*") { depth++; k += 2; } else if (src[k] === "*" && src[k + 1] === "/") { depth--; k += 2; } else k++;
      }
      blank(i, k); i = k; continue;
    }
    if (c === "r" && (n === '"' || n === "#") && !/\w/.test(src[i - 1] ?? "")) {
      let k = i + 1, hashes = 0;
      while (src[k] === "#") { hashes++; k++; }
      if (src[k] === '"') {
        const close = `"${"#".repeat(hashes)}`;
        const e = src.indexOf(close, k + 1);
        const end = e < 0 ? src.length : e + close.length;
        blank(i, end); i = end; continue;
      }
    }
    if (c === '"') {
      let k = i + 1;
      while (k < src.length && src[k] !== '"') { if (src[k] === "\\") k++; k++; }
      blank(i, k + 1); i = k + 1; continue;
    }
    if (c === "'") {
      // A char literal ('x', '\n', '\u{1F600}'); a lifetime ('a, 'static) has no closing quote and stays.
      const m = /^'(?:\\[^']*|[^\\'])'/.exec(src.slice(i, i + 12));
      if (m) { blank(i, i + m[0].length); i += m[0].length; continue; }
    }
    i++;
  }
  return out.join("");
}

interface RustFn { name: string; async: boolean; command: boolean; open: number; close: number; line: number }

const lineOf = (s: string, at: number) => s.slice(0, at).split("\n").length;

/** The end of the bracket that opens at `open` (its matching close), or the end of the text. */
function matching(b: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let k = open; k < b.length; k++) {
    if (b[k] === o) depth++;
    else if (b[k] === c && --depth === 0) return k;
  }
  return b.length;
}

/** Every function with a body, from blanked source. */
function functions(b: string): RustFn[] {
  const out: RustFn[] = [];
  const re = /\b(async\s+)?fn\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  let prevEnd = 0;
  while ((m = re.exec(b))) {
    let k = m.index + m[0].length, parens = 0, open = -1;
    for (; k < b.length; k++) {
      const ch = b[k];
      if (ch === "(") parens++;
      else if (ch === ")") parens--;
      else if (parens === 0 && ch === ";") break;
      else if (parens === 0 && ch === "{") { open = k; break; }
    }
    if (open < 0) continue;
    const before = b.slice(Math.max(prevEnd, m.index - 400), m.index);
    // The attribute lines right above this function (after the previous item's last brace or semicolon).
    const attrs = before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf(";")) + 1);
    out.push({ name: m[2], async: !!m[1], command: /#\[\s*tauri::command\s*\]/.test(attrs), open, close: matching(b, open, "{", "}"), line: lineOf(b, m.index) });
    prevEnd = m.index;
  }
  return out;
}

/** The argument spans of every call that `opener` (ending in "(") starts. */
function spans(b: string, opener: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(opener.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(b))) {
    const open = m.index + m[0].length - 1;
    out.push([open, matching(b, open, "(", ")")]);
  }
  return out;
}

/** Calls that register an event handler: what runs inside them runs later, on the main thread. */
const HANDLERS = /(?:\.(?:on_menu_event|on_tray_icon_event|with_handler|on_window_event|on_page_load|on_webview_event|listen|listen_any|once|once_any)|single_instance::init)\s*\(/;

/** What the rule finds wrong in `src` (lib.rs), and the functions that make windows. */
export function checkWindows(src: string): { makers: string[]; problems: GuardProblem[] } {
  const b = blankRust(src);
  const fns = functions(b);
  const inside = (at: number, list: Array<[number, number]>) => list.some(([a, z]) => at > a && at < z);
  const background = spans(b, /\bin_background\s*\(/);
  const handlers = spans(b, HANDLERS);
  const enclosing = (at: number) => fns.filter((f) => at > f.open && at < f.close).sort((x, y) => (x.close - x.open) - (y.close - y.open))[0];
  const callsOf = (name: string) => [...b.matchAll(new RegExp(`(?<!fn\\s+)\\b${name}\\s*\\(`, "g"))].map((m) => m.index ?? 0);

  // Functions that make a window: those that build one, and those that call one of them other than through in_background.
  const makers = new Set(fns.filter((f) => /\bWebviewWindowBuilder\s*::\s*new\b/.test(b.slice(f.open, f.close))).map((f) => f.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const name of [...makers]) {
      for (const at of callsOf(name)) {
        const f = enclosing(at);
        if (f && !makers.has(f.name) && !inside(at, background) && !inside(at, handlers)) { makers.add(f.name); grew = true; }
      }
    }
  }

  const problems: GuardProblem[] = [];
  for (const f of fns) {
    if (f.command && makers.has(f.name) && !f.async) problems.push({ fn: f.name, line: f.line, why: "a synchronous command makes a window: make it async" });
  }
  for (const name of makers) {
    for (const at of callsOf(name)) {
      if (inside(at, background)) continue;
      const f = enclosing(at);
      if (inside(at, handlers)) { problems.push({ fn: f?.name ?? "?", line: lineOf(b, at), why: `${name} is called in an event handler: hand it to in_background` }); continue; }
      if (!f) { problems.push({ fn: "?", line: lineOf(b, at), why: `${name} is called outside any function` }); continue; }
      if (f.async || f.name === "desktop_setup" || makers.has(f.name)) continue;
      problems.push({ fn: f.name, line: lineOf(b, at), why: `${name} is called from a synchronous function` });
    }
  }
  return { makers: [...makers].sort(), problems };
}
