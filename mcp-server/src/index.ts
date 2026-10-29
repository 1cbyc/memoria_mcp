#!/usr/bin/env node

/**
 * Memoria MCP Server — stdio transport for Claude Code.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore } from "./store.js";
import {
  DB_PATH,
  reindexAll,
  setupWatcher,
  setupPeriodicReindex,
  setupPeriodicOptimize,
  setupPeriodicCompile,
  registerTools,
  registerCollectorTools,
  destroyCollector,
  resumeCollectorIfConfigured,
  setupPrimaryTakeover,
  SERVER_DESCRIPTION,
} from "./tools.js";

// Shared: every Claude Code window and Claude Desktop session starts its own
// stdio server on the same store. The first is the primary; the rest run as
// secondaries (see MemoryStore).
const store = new MemoryStore(DB_PATH, { shared: true });

const server = new McpServer({
  name: "memoria",
  version: "0.3.0",
  description: SERVER_DESCRIPTION,
});

registerTools(server, store);
registerCollectorTools(server, store);

// Declared before main() runs: its first loop iteration reads it
// synchronously, before the rest of this module has been evaluated.
let shuttingDown = false;

async function main(): Promise<void> {
  if (store.needsReindex) {
    process.stderr.write("Memoria: full reindex (embedding provider or index format changed)...\n");
  }
  // Per file: one failure is logged and skipped instead of exiting. A stop
  // signal during a long first index stops before shutdown() closes the
  // store under the next reindexFile. Files deleted while the server was
  // down are dropped.
  const indexed = await reindexAll(store, { shouldStop: () => shuttingDown });
  if (shuttingDown) return;
  process.stderr.write(
    `Memoria MCP server started. Indexed ${indexed.files} files` +
      (indexed.failed.length ? ` (${indexed.failed.length} failed, see above).\n` : ".\n"),
  );

  setupWatcher(store);
  setupPeriodicReindex(store);
  setupPeriodicOptimize(store); // no-op unless MEMORIA_AUTO_OPTIMIZE=true
  setupPeriodicCompile(store); // no-op unless MEMORIA_AUTO_COMPILE=true
  setupPrimaryTakeover(store); // no-op in the primary

  const transport = new StdioServerTransport();
  // Exit when the client goes away. Without this a server whose client died
  // without sending a signal lived on (the file watcher keeps the event loop
  // busy), holding the store lock for every later session.
  // (Several of these fire for one disconnect; only signals escalate a
  // second request to a forced exit.)
  const clientGone = () => {
    if (!shuttingDown) void shutdown();
  };
  transport.onclose = clientGone;
  process.stdin.on("end", clientGone);
  process.stdin.on("close", clientGone);
  await server.connect(transport);

  // After connecting, so a slow source (an IMAP login) never delays the
  // client's handshake. Errors are logged inside.
  void resumeCollectorIfConfigured(store);
}

main().catch((err) => {
  // Once shutting down, an error from work cut short is expected; exiting 1
  // here would pre-empt shutdown()'s clean exit(0).
  if (shuttingDown) return;
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});

// SIGTERM as well as SIGINT: a client stopping this stdio server, a service
// manager, or a container runtime sends SIGTERM, and without a handler the
// process died without closing SQLite or flushing the collector. A second
// signal while shutting down forces the exit.

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  setTimeout(() => process.exit(1), 8_000).unref();
  let exitCode = 0;
  try {
    await destroyCollector();
  } catch (err) {
    process.stderr.write(`Memoria: error during shutdown: ${err}\n`);
    exitCode = 1;
  } finally {
    store.close();
  }
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown());
}
