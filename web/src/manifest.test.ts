import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const web = path.resolve(__dirname, "..");

describe("the installed web app", () => {
  it("is named Aeneas on the home screen and in the app list", () => {
    const m = JSON.parse(fs.readFileSync(path.join(web, "public/manifest.webmanifest"), "utf8")) as { name: string; short_name: string };
    expect(m.name).toBe("Aeneas");
    expect(m.short_name).toBe("Aeneas");
    const html = fs.readFileSync(path.join(web, "index.html"), "utf8");
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Aeneas" />');
    expect(html).toContain("<title>Aeneas</title>");
    expect(html).not.toMatch(/content="Everything"/);
  });
  it("knows its own version, the one the Windows and Android apps are built with (Settings, About)", () => {
    const conf = JSON.parse(fs.readFileSync(path.join(web, "src-tauri/tauri.conf.json"), "utf8")) as { version: string };
    expect(import.meta.env.VITE_APP_VERSION).toBe(conf.version);
  });
});
