// Builds the Claude Desktop extension: one bundled server file + manifest + icon -> sahajta-ads.mcpb.
// The .mcpb is copied to ../public/downloads so the app can serve it from Settings.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "server"), { recursive: true });

await build({
  entryPoints: [path.join(here, "server.ts")],
  outfile: path.join(dist, "server/index.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  nodePaths: [path.join(here, "../node_modules")],
  logLevel: "warning",
});

fs.copyFileSync(path.join(here, "manifest.json"), path.join(dist, "manifest.json"));

// Icon: rendered from SVG with sharp (already a dependency of the app).
const require = createRequire(path.join(here, "../package.json"));
const sharp = require("sharp");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="112" fill="#1f5eff"/><text x="256" y="320" font-family="Helvetica, Arial, sans-serif" font-size="192" font-weight="700" fill="#fff" text-anchor="middle">SA</text></svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(dist, "icon.png"));

const out = path.join(here, "sahajta-ads.mcpb");
execFileSync(path.join(here, "node_modules/.bin/mcpb"), ["pack", dist, out], { stdio: "inherit" });
const pub = path.join(here, "../public/downloads");
fs.mkdirSync(pub, { recursive: true });
fs.copyFileSync(out, path.join(pub, "sahajta-ads.mcpb"));
console.log(`Built ${out} and copied it to public/downloads/`);
