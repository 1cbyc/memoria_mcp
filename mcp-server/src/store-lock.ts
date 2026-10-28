/**
 * Single-process guard for a memory store directory (review H3).
 * Two server processes on one store race: SQLite writers hit SQLITE_BUSY
 * with no retry, and the collector registry's whole-state replace is
 * last-writer-wins. Taking an exclusive lock file at store open makes the
 * second process fail loudly at startup instead. A lock left by a dead
 * process (pid no longer alive) is reclaimed.
 *
 * The lock records "<pid>\n<hostname>". A pid is only meaningful on the host
 * that wrote it, and a pid alone is not an identity: a container restarted
 * after a crash usually hands node the same small pid it had before, so the
 * leftover lock named a live process (the new server itself) and the store
 * refused to open forever. Locks this process holds are therefore tracked in
 * memory, and a lock naming our own pid that we do not hold is a leftover.
 *
 * Scope: this guards processes on one host. A lock written by another host
 * (a shared mount such as GCS FUSE) cannot be checked, and refusing it would
 * deadlock a Cloud Run rollout, where the new instance must start while the
 * old one still runs; it is reclaimed with a warning instead.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const heldLocks = new Set<string>();

function parseLock(text: string): { pid: number; host: string | null } {
  const [pidLine, hostLine] = text.split("\n");
  return { pid: parseInt((pidLine ?? "").trim(), 10), host: hostLine?.trim() || null };
}

export function acquireStoreLock(dbPath: string): () => void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // Per database file: the two server entry points share one DB_PATH, while
  // tests/tools may legitimately open a different sqlite file beside it.
  const lockPath = path.join(dir, `.${path.basename(dbPath)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${os.hostname()}`, "utf-8");
      fs.closeSync(fd);
      heldLocks.add(lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        heldLocks.delete(lockPath);
        try {
          if (parseLock(fs.readFileSync(lockPath, "utf-8")).pid === process.pid) {
            fs.rmSync(lockPath, { force: true });
          }
        } catch {
          // best-effort release
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = NaN;
      let holderHost: string | null = null;
      let lockAgeMs = Infinity;
      try {
        ({ pid: holder, host: holderHost } = parseLock(fs.readFileSync(lockPath, "utf-8")));
        lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // unreadable lock: treat as held rather than racing
      }
      // A lock without a host predates the host field; assume it is local.
      const foreignHost = holderHost !== null && holderHost !== os.hostname();
      // Only ESRCH proves the holder is gone. EPERM means a live process
      // owned by another user — treating any throw as "dead" would reclaim
      // a live holder's lock.
      let alive = false;
      if (foreignHost) {
        process.stderr.write(
          `Memoria: store lock at ${lockPath} was written on host "${holderHost}" (pid ${holder}). ` +
            `It cannot be checked from here, so it is taken over. Make sure no other host ` +
            `runs a server on this store.\n`,
        );
      } else if (holder === process.pid) {
        // Our own pid: held by this process (a second open in-process), or a
        // leftover from a previous process that had the same pid.
        alive = heldLocks.has(lockPath);
      } else if (Number.isFinite(holder)) {
        try {
          process.kill(holder, 0);
          alive = true;
        } catch (killErr) {
          alive = (killErr as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      // An empty/unparseable lock is a crash between create and pid-write:
      // reclaimable only once it is clearly not a just-created lock.
      const staleEmpty = !Number.isFinite(holder) && lockAgeMs > 5000;
      if (alive || (!Number.isFinite(holder) && !staleEmpty)) {
        throw new Error(
          `Memoria store at ${dir} is already in use by another Memoria process` +
            (Number.isFinite(holder) ? ` (pid ${holder})` : "") +
            `. Stop that process first; running two servers on one store corrupts the index.`,
          { cause: err },
        );
      }
      // Reclaim atomically: rename the stale lock aside (only one reclaimer
      // wins the rename) instead of deleting whatever is at the path, which
      // could be a live successor's lock.
      const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lockPath, stalePath);
        fs.rmSync(stalePath, { force: true });
      } catch {
        throw new Error(
          `Memoria store at ${dir} is already in use by another Memoria process. ` +
            `Stop that process first; running two servers on one store corrupts the index.`,
          { cause: err },
        );
      }
    }
  }
  throw new Error(`Memoria: could not acquire store lock at ${lockPath}`);
}
