import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FeelLayer } from "./feel/FeelLayer";
import { initPwa } from "./pwa";
import "./styles.css";

initPwa();

// A screen's file from an older copy of the app (the hub updated while this page stayed open, with no offline copy
// kept) is gone from the hub: load the new copy, once a minute at most, instead of leaving a screen that cannot open.
window.addEventListener("vite:preloadError", () => {
  try {
    if (!navigator.onLine || Date.now() - Number(sessionStorage.getItem("ea-reloaded-at") ?? 0) < 60_000) return;
    sessionStorage.setItem("ea-reloaded-at", String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <FeelLayer />
  </React.StrictMode>,
);
