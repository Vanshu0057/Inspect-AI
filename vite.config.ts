import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const runtimeAssets = [
  ["tesseract/worker.min.js", "node_modules/tesseract.js/dist/worker.min.js"],
  ["tesseract/tesseract-core-lstm.wasm.js", "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js"],
  ["tesseract/tesseract-core-lstm.wasm", "node_modules/tesseract.js-core/tesseract-core-lstm.wasm"],
] as const;

function offlineSupport(): Plugin {
  return {
    name: "inspect-ai-offline-support",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET") {
          next();
          return;
        }

        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const asset = runtimeAssets.find(([fileName]) => pathname.endsWith(`/${fileName}`));
        if (!asset) {
          next();
          return;
        }

        const source = readFileSync(resolve(projectRoot, asset[1]));
        response.setHeader(
          "Content-Type",
          asset[0].endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
        );
        response.setHeader("Content-Length", source.byteLength);
        response.end(source);
      });
    },
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");

      for (const [fileName, sourcePath] of runtimeAssets) {
        const source = readFileSync(resolve(projectRoot, sourcePath));
        this.emitFile({
          type: "asset",
          fileName,
          source,
        });
        hash.update(fileName).update(source);
      }

      const precacheFiles = [...new Set([
        "index.html",
        "manifest.webmanifest",
        "app-icon.svg",
        ...Object.entries(bundle)
          .filter(([fileName]) => fileName !== "sw.js" && !fileName.endsWith(".map"))
          .map(([fileName]) => fileName),
        ...runtimeAssets.map(([fileName]) => fileName),
      ])];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === "sw.js" || fileName.endsWith(".map")) continue;
        hash.update(fileName).update(output.type === "asset" ? output.source : output.code);
      }
      const cacheName = `inspect-ai-offline-${hash.digest("hex").slice(0, 12)}`;
      const workerSource = `
const CACHE_NAME = "${cacheName}";
const PRECACHE_FILES = ${JSON.stringify(precacheFiles)};
const APP_ROOT = new URL("./", self.registration.scope);
const APP_SHELL = new URL("index.html", APP_ROOT).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_FILES.map((file) => new URL(file, APP_ROOT).href));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => (name.startsWith("inspect-ai-offline-") || /^inspect-ai-\\d+-[a-f0-9]+$/.test(name)) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.mode === "navigate") {
        const shell = await cache.match(APP_SHELL);
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source: workerSource });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineSupport()],
});
