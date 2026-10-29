/**
 * Single-process guard for a memory store directory (review H3).
 * Two server processes on one store race: SQLite writers hit SQLITE_BUSY
 * with no retry, and the collector registry's whole-state replace is
 * last-writer-wins. Taking an exclusive lock file at store open makes the
 * second process fail loudly at startup instead.
 *
 * The lock records "<pid>\n<hostname>\n<process start ms>" and its holder
 * refreshes the file's mtime every HEARTBEAT_MS. A lock is stale, and
 * reclaimed, when:
 *
 * - it was written on this host and its pid is gone (ESRCH);
 * - it names our own pid but this process does not hold it: a container
 *   restarted after a crash usually hands node the same small pid, and the
 *   leftover lock used to block every restart;
 * - its pid is alive but belongs to a process that started at a different
 *   time (a reused pid; checked through /proc on Linux, elsewhere a live
 *   pid counts as the holder);
 * - it was written on another host (a recreated container, a shared mount),
 *   whose pid means nothing here, and its heartbeat stopped more than
 *   STALE_MS ago.
 *
 * A live local holder is never judged by its heartbeat: a process paused
 * by SIGSTOP or a laptop's sleep misses beats while still running, and
 * taking its lock would put two writers on one store.
 *
 * A fresh lock from another host is waited on for up to one stale window
 * (its holder may just have crashed), then refused. A deployment that
 * deliberately overlaps instances on one shared store, as a Cloud Run
 * rollout does, sets MEMORIA_LOCK_TAKEOVER=true: the new instance must
 * start while the old one still runs, so it takes the lock over instead.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;
/** A lock caught between create and its content being written. */
const UNWRITTEN_GRACE_MS = 5_000;
const MAX_RECLAIMS = 5;

/** Locks held by this process, by real path, with their heartbeat timers. */
const heldLocks = new Map<string, NodeJS.Timeout>();

function parseLock(text: string): { pid: number; host: string | null; startMs: number } {
  const [pidLine, hostLine, startLine] = text.split("\n");
  return {
    pid: parseInt((pidLine ?? "").trim(), 10),
    host: hostLine?.trim() || null,
    startMs: Number((startLine ?? "").trim()) || NaN,
  };
}

/**
 * When a process started, in epoch ms, from /proc (Linux only). Field 22 of
 * /proc/<pid>/stat is the start time in clock ticks since boot (USER_HZ,
 * 100 on every mainstream Linux); /proc/stat's btime is the boot time.
 * Both live in the same clock, also inside a container's pid namespace.
 */
function linuxProcessStartMs(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The command name may contain spaces or parentheses; fields resume
    // after its last ")". The first field there is field 3 (state).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[22 - 3]);
    const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf-8"))?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return undefined;
    return btime * 1000 + startTicks * 10;
  } catch {
    return undefined;
  }
}

function ownStartMs(): number {
  return linuxProcessStartMs(process.pid) ?? Math.round(Date.now() - process.uptime() * 1000);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type Verdict =
  | { kind: "gone" }
  | { kind: "stale"; observed: string; why: string }
  | { kind: "foreign"; observed: string; host: string; pid: number }
  | { kind: "pending" }
  | { kind: "held"; pid: number };

function inspect(lockPath: string): Verdict {
  let observed: string;
  let ageMs: number;
  try {
    observed = fs.readFileSync(lockPath, "utf-8");
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
    return { kind: "held", pid: NaN }; // unreadable: treat as held rather than race
  }
  const { pid, host, startMs } = parseLock(observed);
  if (!Number.isFinite(pid)) {
    return ageMs > UNWRITTEN_GRACE_MS
      ? { kind: "stale", observed, why: "it is empty" }
      : { kind: "pending" };
  }
  // A lock without a host predates the host field and the heartbeat; it is
  // judged by its pid alone.
  const heartbeats = host !== null;
  if (heartbeats && host !== os.hostname()) {
    return ageMs > STALE_MS
      ? { kind: "stale", observed, why: `its holder on "${host}" stopped refreshing it` }
      : { kind: "foreign", observed, host, pid };
  }
  if (pid === process.pid) {
    // Held by this process (a second open), or a leftover from an earlier
    // process that had the same pid.
    return heldLocks.has(lockPath)
      ? { kind: "held", pid }
      : { kind: "stale", observed, why: "it is a leftover with this process's pid" };
  }
  try {
    process.kill(pid, 0);
  } catch (killErr) {
    // Only ESRCH proves the holder is gone. EPERM means a live process
    // owned by another user.
    if ((killErr as NodeJS.ErrnoException).code === "ESRCH") {
      return { kind: "stale", observed, why: `pid ${pid} is gone` };
    }
  }
  // Alive. Ours only if it is the same process that wrote the lock: a
  // different start time means the pid was reused.
  const liveStart = Number.isFinite(startMs) ? linuxProcessStartMs(pid) : undefined;
  if (liveStart !== undefined && Math.abs(liveStart - startMs) > 1_000) {
    return { kind: "stale", observed, why: `pid ${pid} now belongs to another process` };
  }
  return { kind: "held", pid };
}

/**
 * Move a stale lock out of the way, but only the lock that was judged: if
 * another process reclaimed it and created its own in between, the file
 * now at the path is that fresh lock, and it is put back. Returns whether
 * the path is free to create.
 */
function reclaim(lockPath: string, observed: string): boolean {
  const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return false; // someone else moved it first
  }
  let moved: string;
  try {
    moved = fs.readFileSync(aside, "utf-8");
  } catch {
    // unreadable: assume it was the one we judged
    moved = observed;
  }
  if (moved !== observed) {
    try {
      fs.linkSync(aside, lockPath); // fails if yet another lock exists
    } catch {
      // the path is taken again either way; the caller re-inspects
    }
    fs.rmSync(aside, { force: true });
    return false;
  }
  fs.rmSync(aside, { force: true });
  return true;
}

/** The store is held by another live Memoria process. */
export class StoreInUseError extends Error {
  constructor(
    readonly dir: string,
    readonly holderPid: number,
    cause?: unknown,
    /** The holder is on another host (a shared network mount). */
    readonly foreign = false,
  ) {
    super(
      `Memoria store at ${dir} is already in use by another Memoria process` +
        (Number.isFinite(holderPid) ? ` (pid ${holderPid})` : "") +
        `. Stop that process first; running two servers on one store corrupts the index.`,
      { cause },
    );
    this.name = "StoreInUseError";
  }
}

function inUse(dir: string, pid: number, cause?: unknown, foreign = false): Error {
  return new StoreInUseError(dir, pid, cause, foreign);
}

export function acquireStoreLock(
  dbPath: string,
  opts: { foreignWaitMs?: number } = {},
): () => void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // Per database file: the two server entry points share one DB_PATH, while
  // tests/tools may legitimately open a different sqlite file beside it.
  // Real path, so two spellings of one directory are one lock.
  const lockPath = path.join(fs.realpathSync(dir), `.${path.basename(dbPath)}.lock`);
  const takeover = process.env.MEMORIA_LOCK_TAKEOVER === "true";
  const foreignWaitMs = opts.foreignWaitMs ?? STALE_MS + HEARTBEAT_MS;
  const foreignDeadline = Date.now() + foreignWaitMs;
  let reclaims = 0;

  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const v = inspect(lockPath);
      switch (v.kind) {
        case "gone":
          continue;
        case "held":
          throw inUse(dir, v.pid, err);
        case "pending":
          sleepSync(250);
          continue;
        case "foreign":
          if (takeover) {
            process.stderr.write(
              `Memoria: taking over the store lock at ${lockPath} from host "${v.host}" ` +
                `(pid ${v.pid}) because MEMORIA_LOCK_TAKEOVER=true.\n`,
            );
            if (reclaim(lockPath, v.observed) || ++reclaims < MAX_RECLAIMS) continue;
            throw inUse(dir, v.pid, err, true);
          }
          if (Date.now() < foreignDeadline) {
            if (reclaims === 0) {
              process.stderr.write(
                `Memoria: the store at ${dir} is locked by host "${v.host}" (pid ${v.pid}); ` +
                  `waiting up to ${Math.round(foreignWaitMs / 1000)}s in case it has stopped.\n`,
              );
              reclaims = -1; // only announce once
            }
            sleepSync(1_000);
            continue;
          }
          throw inUse(dir, v.pid, err, true);
        case "stale":
          process.stderr.write(`Memoria: reclaiming the store lock at ${lockPath}: ${v.why}.\n`);
          if (reclaim(lockPath, v.observed) || ++reclaims < MAX_RECLAIMS) continue;
          throw inUse(dir, NaN, err);
      }
    }

    const written = `${process.pid}\n${os.hostname()}\n${ownStartMs()}`;
    fs.writeFileSync(fd, written, "utf-8");
    fs.closeSync(fd);
    // Everything below acts only while the file still holds what we wrote:
    // after a takeover, the old holder must neither refresh nor delete its
    // successor's lock.
    const stillOurs = () => {
      try {
        return fs.readFileSync(lockPath, "utf-8") === written;
      } catch {
        return false;
      }
    };
    let lostWarned = false;
    const heartbeat = setInterval(() => {
      if (!stillOurs()) {
        if (!lostWarned) {
          lostWarned = true;
          process.stderr.write(
            `Memoria: WARNING — the store lock at ${lockPath} was taken over by another ` +
              `process. Two servers may now be writing this store; stop one of them.\n`,
          );
        }
        return;
      }
      try {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
      } catch {
        // best effort; a missed beat only risks a takeover after STALE_MS
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
    heldLocks.set(lockPath, heartbeat);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      heldLocks.delete(lockPath);
      try {
        if (stillOurs()) fs.rmSync(lockPath, { force: true });
      } catch {
        // best-effort release
      }
    };
  }
}
