#!/usr/bin/env node
/**
 * One-command demo: build (if needed) -> generate fake data -> launch the
 * dashboard against a throwaway store. Your real memory store is never touched.
 *
 *   node scripts/demo.mjs
 *   PORT=4000 MEMORIA_API_KEY=mykey node scripts/demo.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(mcpDir, "..");

const OUT = path.join(repoRoot, "demo-store");
const PORT = process.env.PORT || "3110";
const KEY = process.env.MEMORIA_API_KEY || "demo-key-123";

// 0. Dependencies first. Without them the build prints hundreds of type errors
// (and still writes dist/), so a retry skipped the build and died with
// ERR_MODULE_NOT_FOUND instead of saying what was missing.
if (!fs.existsSync(path.join(mcpDir, "node_modules", "express"))) {
  console.error(
    `Dependencies are not installed. Run this first:\n\n  cd ${mcpDir}\n  npm install\n`,
  );
  process.exit(1);
}

// 1. Ensure the server is built.
if (!fs.existsSync(path.join(mcpDir, "dist", "http.js"))) {
  console.log("Building mcp-server (dist/http.js missing)…");
  const b = spawnSync("npm", ["run", "build"], { cwd: mcpDir, stdio: "inherit", shell: true });
  if (b.status !== 0) {
    console.error("Build failed.");
    process.exit(1);
  }
}

// 2. Generate the demo data.
const g = spawnSync(
  process.execPath,
  [path.join(__dirname, "generate-demo-data.mjs"), "--out", OUT],
  { stdio: "inherit" },
);
if (g.status !== 0) process.exit(g.status ?? 1);

// 3. Launch the dashboard against the demo store.
console.log("\n──────────────────────────────────────────────");
console.log("  DEMO DASHBOARD (throwaway data — real store untouched)");
console.log(`  URL : http://127.0.0.1:${PORT}/dashboard`);
console.log(`  Key : ${KEY}`);
console.log("  Ctrl+C to stop.");
console.log("──────────────────────────────────────────────\n");

const srv = spawn(process.execPath, [path.join(mcpDir, "dist", "http.js")], {
  cwd: mcpDir,
  stdio: "inherit",
  env: {
    ...process.env,
    MEMORIA_API_KEY: KEY,
    MEMORIA_OAUTH_CLIENT_SECRET: KEY,
    MEMORIA_DIR: OUT,
    MEMORIA_EMBEDDINGS: "hash",
    PORT,
    // never bind to 0.0.0.0 for a local demo
    BIND_ALL: "false",
  },
});
srv.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => srv.kill("SIGINT"));
