import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@leeguoo/design-tokens/tokens.css";
import "@leeguoo/design-tokens/themes/google.css";
import "@leeguoo/design-tokens/themes/google-brand-paste.css";
import "bootstrap/dist/css/bootstrap.min.css";
import "@leeguoo/theme-bootstrap/bootstrap-google.css";
import "./index.css";

const SW_CACHE_PREFIX = "pastyx-";
const SW_CACHE_NAME = "pastyx-v2";
const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "/");
const SW_URL = `${BASE_URL}sw.js`;

const clearLegacyServiceWorkerCaches = async (): Promise<void> => {
  if (!("caches" in window)) {
    return;
  }

  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SW_CACHE_PREFIX) && key !== SW_CACHE_NAME)
      .map((key) => caches.delete(key))
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(SW_URL)
      .then(() => clearLegacyServiceWorkerCaches())
      .catch((err) => {
        console.log("Service Worker registration failed: ", err);
      });
  });
}
