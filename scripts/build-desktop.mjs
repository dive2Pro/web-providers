import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const outDir = resolve(rootDir, "dist-electron");
const rendererSourceDir = resolve(rootDir, "electron", "renderer");
const rendererOutDir = resolve(outDir, "renderer");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(rootDir, "electron", "main.ts")],
  outdir: outDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  sourcemap: false,
  logLevel: "info",
  packages: "external",
  external: ["electron"],
});

await build({
  entryPoints: [resolve(rootDir, "electron", "preload.ts")],
  outdir: outDir,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node20"],
  sourcemap: false,
  logLevel: "info",
  packages: "external",
  external: ["electron"],
  outExtension: {
    ".js": ".cjs",
  },
});

await cp(rendererSourceDir, rendererOutDir, {
  recursive: true,
});
