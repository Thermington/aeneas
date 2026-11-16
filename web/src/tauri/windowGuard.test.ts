import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { blankRust, checkWindows } from "./windowGuard";

const lib = fs.readFileSync(path.resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf8");

describe("windows in the Windows and Android app", () => {
  it("are never made where Windows deadlocks: synchronous commands or event handlers", () => {
    const r = checkWindows(lib);
    expect(r.problems).toEqual([]);
    // The check sees the windows the app makes, so an empty list above means something.
    expect(r.makers).toEqual(expect.arrayContaining(["open_capture", "open_widget", "open_window"]));
  });

  it("catches the code that froze the Now widget and Capture on Windows", () => {
    const old = `
const CAPTURE: &str = "capture"; // open_capture(app) in a comment does not count
#[tauri::command]
fn set_widget(app: AppHandle, open: bool) {
    if open { open_widget(&app); }
}
fn open_widget<R: Runtime>(app: &AppHandle<R>) {
    let _ = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("index.html#/widget".into())).build();
}
fn open_capture<R: Runtime>(app: &AppHandle<R>) {
    let _ = WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("index.html#/capture".into())).build();
}
fn desktop_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let tray = TrayIconBuilder::with_id("main").on_menu_event(move |app, event| match event.id.as_ref() {
        "capture" => open_capture(app),
        _ => {}
    });
    open_widget(app.handle());
    Ok(())
}`;
    const r = checkWindows(old);
    expect(r.problems.map((p) => [p.fn, p.why])).toEqual([
      ["set_widget", "a synchronous command makes a window: make it async"],
      ["desktop_setup", "open_capture is called in an event handler: hand it to in_background"],
    ]);
  });

  it("allows async commands, in_background and the setup hook", () => {
    const fine = `
#[tauri::command]
async fn open_window(app: AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(&app, "pop-1", WebviewUrl::App("index.html".into())).build().map(|_| ()).map_err(|e| e.to_string())
}
fn open_widget<R: Runtime>(app: &AppHandle<R>) {
    let _ = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("index.html#/widget".into())).build();
}
fn desktop_setup(app: &mut tauri::App) {
    let tray = TrayIconBuilder::with_id("main").on_menu_event(move |app, _event| in_background(app, move |app| open_widget(app)));
    open_widget(app.handle());
}`;
    expect(checkWindows(fine).problems).toEqual([]);
  });

  it("reads past comments, strings, char literals and lifetimes", () => {
    const b = blankRust(`fn a<'s>(x: &'s str) { let c = '{'; let s = "}"; /* } */ } // }`);
    expect(b.includes("{ let")).toBe(true);
    expect((b.match(/[{}]/g) ?? []).join("")).toBe("{}");
  });
});
