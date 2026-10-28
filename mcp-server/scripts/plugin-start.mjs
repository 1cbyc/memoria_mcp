#!/usr/bin/env node
/**
 * MCP stdio entry point for the Claude Code plugin.
 *
 * A plugin install is a git clone — nothing runs `npm install`, so on first
 * launch there are no dependencies and no `dist/`. This wrapper makes the
 * plugin self-installing: it fetches dependencies once if they are missing,
 * then hands off to `mcp-start.mjs`, which builds from source and serves.
 *
 * Two hard constraints, inherited from mcp-start.mjs:
 *   1. stdout is the JSON-RPC transport. Every byte npm and tsc emit must be
 *      redirected to stderr or the stream is corrupted and the server looks
 *      broken to the client.
 *   2. Nothing here may hang forever. A first install compiling better-sqlite3
 *      from source can take a while; the client's startup timeout is the real
 *      limit, so we log progress to stderr and let the user see it.
 *
 * For an npm install, `npx -y @agrippa87/memoria-mcp` is the simpler
 * command and this wrapper is only needed for a source install.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, ".."); // mcp-server/
const nodeModules = path.join(root, "node_modules");
const sdk = path.join(nodeModules, "@modelcontextprotocol", "sdk");

function note(msg) {
  process.stderr.write(`Memoria plugin: ${msg}\n`);
}

// `node_modules` can exist but be incomplete (an interrupted install), so probe
// for a package we actually import rather than just the directory.
if (!existsSync(nodeModules) || !existsSync(sdk)) {
  note("first run — installing dependencies (this happens once, and can take a minute)");
  const started = Date.now();
  const isWindows = process.platform === "win32";
  // `ci` when the lockfile is there (it always is in a plugin checkout): the
  // exact, audited dependency tree, and the lockfile is never rewritten.
  // `install` resolved afresh within the semver ranges.
  const hasLock = existsSync(path.join(root, "package-lock.json"));
  const NPM_ARGS = [hasLock ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel", "error"];
  const options = {
    cwd: root,
    // stdout piped, NOT inherited: npm writes progress to stdout and that
    // would corrupt the JSON-RPC stream.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  };

  // On Windows `npm` is a .cmd shim, and since the CVE-2024-27980 fix Node
  // refuses to spawn one without a shell. Pass the whole line as a single
  // string rather than shell + argv, which avoids DEP0190 (unescaped argument
  // concatenation). Nothing here is user input.
  const install = isWindows
    ? spawnSync(`npm ${NPM_ARGS.join(" ")}`, { ...options, shell: true })
    : spawnSync("npm", NPM_ARGS, options);

  const output = `${install.stdout || ""}${install.stderr || ""}`.trim();
  if (output) process.stderr.write(output + "\n");

  if (install.error || install.status !== 0) {
    note(
      `dependency install FAILED (${install.error ? install.error.message : `exit ${install.status}`}). ` +
        "Install by hand:\n" +
        `  cd ${root}\n` +
        "  npm install\n" +
        "better-sqlite3 is a native module — a compiler toolchain may be required.",
    );
    process.exit(1);
  }
  note(`dependencies installed in ${Math.round((Date.now() - started) / 1000)}s`);
}

// mcp-start.mjs owns build-then-serve (and the stale-dist fallback).
await import(pathToFileURL(path.join(here, "mcp-start.mjs")).href);
