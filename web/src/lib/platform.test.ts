import { describe, expect, it } from "vitest";
import { isMacBrowser, pairingName } from "./platform";

const ANDROID_APP = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36";
const WINDOWS_APP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

describe("the Mac app link", () => {
  it("shows only in a browser on a Mac", () => {
    expect(isMacBrowser(MAC_SAFARI, false)).toBe(true);
    expect(isMacBrowser(IPHONE_SAFARI, false)).toBe(false);
    expect(isMacBrowser(WINDOWS_APP, false)).toBe(false);
  });
  it("never in the Windows or Android app, where it would open that app again", () => {
    expect(isMacBrowser(WINDOWS_APP, true)).toBe(false);
    expect(isMacBrowser(ANDROID_APP, true)).toBe(false);
    expect(isMacBrowser(MAC_SAFARI, true)).toBe(false);
  });
});

describe("the name a device pairs with", () => {
  it("an Android phone is not named iPhone by a code made with the suggested name", () => {
    expect(pairingName("iPhone", "Android", ANDROID_APP)).toBe("Android");
    expect(pairingName("iPad", "Android", ANDROID_APP)).toBe("Android");
    expect(pairingName("Mac", "Windows", WINDOWS_APP)).toBe("Windows");
  });
  it("keeps a name that fits the device, or one somebody typed", () => {
    expect(pairingName("iPhone", "Browser", IPHONE_SAFARI)).toBe("iPhone");
    expect(pairingName("Android", "Android", ANDROID_APP)).toBe("Android");
    expect(pairingName("Windows", "Windows", WINDOWS_APP)).toBe("Windows");
    expect(pairingName("Alex's Pixel", "Android", ANDROID_APP)).toBe("Alex's Pixel");
    expect(pairingName("  Kitchen tablet ", "Browser", MAC_SAFARI)).toBe("Kitchen tablet");
  });
  it("a code with no name or a placeholder name gives the device's own", () => {
    expect(pairingName(null, "Android", ANDROID_APP)).toBe("Android");
    expect(pairingName("", "Windows", WINDOWS_APP)).toBe("Windows");
    expect(pairingName("New device", "Android", ANDROID_APP)).toBe("Android");
    expect(pairingName("My device", "Browser", MAC_SAFARI)).toBe("Browser");
  });
});
