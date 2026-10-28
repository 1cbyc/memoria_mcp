#!/usr/bin/env node
/**
 * MCP stdio entry point that builds before it serves.
 *
 * Why this exists: the MCP client used to launch `node dist/index.js` directly.
 * `dist/` is gitignored and nothing rebuilt it, so the globally registered
 * server silently ran a 2026-06-05 build for seven weeks — none of the July
 * remediation (PRs #23-#27) was live, and `memory_entities` wasn't even
 * registered. Pointing the launcher at an artifact that nothing produces
 * guarantees drift; this wrapper closes that gap.
 *
 * Two hard constraints:
 *   1. stdout is the JSON-RPC transport. `tsc` writes diagnostics to *stdout*,
 *      which would corrupt the stream, so compiler output is captured and
 *      re-emitted on stderr.
 *   2. A type error must not leave the user with no memory at all. If the build
 *      fails but a previous `dist/` exists, warn loudly and serve the stale
 *      build rather than exiting. (tsconfig sets noEmitOnError, so a failed
 *      build leaves that previous dist/ untouched instead of overwriting it
 *      with the broken output.)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const lock = path.join(root, ".build.lock");

const warn = (msg) => process.stderr.write(`Memoria launcher: ${msg}\n`);

// Concurrent-launch guard: several Claude Code windows starting at once would
// each run tsc into the shared dist/, and one server could import files the
// other compiler is mid-rewrite. First launcher takes the lock and builds;
// the others skip the build (a <60s-old lock) and serve what's there — worst
// case one launch serves the previous build, loudly noted.
let buildAllowed = true;
try {
  const age = Date.now() - statSync(lock).mtimeMs;
  if (age < 60_000) {
    buildAllowed = false;
    warn(
      `another launcher holds the build lock (${Math.round(age / 1000)}s old) — skipping build, serving existing dist/`,
    );
  } else {
    rmSync(lock, { force: true }); // stale lock from a killed launcher
  }
} catch {
  // no lock — we'll take it
}

if (existsSync(tsc) && buildAllowed) {
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(lock, String(process.pid));
  } catch {}
  const started = Date.now();
  // stdio: pipe everything — nothing from the compiler may reach stdout.
  const build = spawnSync(process.execPath, [tsc], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  const output = `${build.stdout || ""}${build.stderr || ""}`.trim();
  if (output) process.stderr.write(output + "\n");

  try {
    rmSync(lock, { force: true });
  } catch {}

  if (build.status === 0) {
    warn(`build OK (${Date.now() - started}ms)`);
  } else if (existsSync(entry)) {
    warn(
      `BUILD FAILED (exit ${build.status}) — serving the previous dist/ build, ` +
        `which may be stale. Fix the errors above and restart.`,
    );
  } else {
    warn(`BUILD FAILED (exit ${build.status}) and no previous dist/ to fall back on.`);
    process.exit(1);
  }
} else if (!existsSync(entry)) {
  warn(
    buildAllowed
      ? `typescript is not installed and dist/ is missing — run 'npm ci' in ${root}.`
      : "build lock held by another launcher and no dist/ exists yet — retry shortly.",
  );
  process.exit(1);
} else if (buildAllowed) {
  warn("typescript not installed — serving the existing dist/ build unbuilt.");
} // else: lock-skip already warned above.

await import(pathToFileURL(entry).href);
