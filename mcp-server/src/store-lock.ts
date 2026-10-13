/**
 * Single-process guard for a memory store directory (review H3).
 * Two server processes on one store race: SQLite writers hit SQLITE_BUSY
 * with no retry, and the collector registry's whole-state replace is
 * last-writer-wins. Taking an exclusive lock file at store open makes the
 * second process fail loudly at startup instead. A lock left by a dead
 * process (pid no longer alive) is reclaimed.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function acquireStoreLock(dbPath: string): () => void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // Per database file: the two server entry points share one DB_PATH, while
  // tests/tools may legitimately open a different sqlite file beside it.
  const lockPath = path.join(dir, `.${path.basename(dbPath)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid), "utf-8");
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(lockPath, "utf-8").trim() === String(process.pid)) {
            fs.rmSync(lockPath, { force: true });
          }
        } catch {
          // best-effort release
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = NaN;
      let lockAgeMs = Infinity;
      try {
        holder = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
        lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // unreadable lock: treat as held rather than racing
      }
      // Only ESRCH proves the holder is gone. EPERM means a live process
      // owned by another user — treating any throw as "dead" would reclaim
      // a live holder's lock.
      let alive = false;
      if (Number.isFinite(holder)) {
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
