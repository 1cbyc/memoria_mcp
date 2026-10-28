/**
 * Paths of daily logs (memories/daily/YYYY-MM-DD.md), refusing symlinks.
 *
 * resolveMemoryPath refuses symlinks for memories addressed by name, but
 * the daily-log paths were built directly, and a git pull checks symlinks
 * out as real links: anyone able to push to the store's remote could plant
 * `daily/<today>.md -> ~/.ssh/config` and have memory_daily, the collector
 * or the dashboard journal append to it, or memory_reflect read it out.
 * The memories directory itself may be a symlink (a store kept elsewhere);
 * `daily/` and the log files inside it may not.
 */
import fs from "node:fs";
import path from "node:path";

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false; // missing
  }
}

/**
 * The path of the daily log for `date`, creating daily/ if needed. Throws
 * if daily/ or the log is a symlink or not a regular file.
 */
export function dailyLogPath(memoriesDir: string, date: string): string {
  const dir = path.join(memoriesDir, "daily");
  if (isSymlink(dir)) throw new Error("Refusing a symlinked memories/daily directory.");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  try {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error(`Refusing daily log ${date}.md: not a regular file (a symlink?).`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return file;
}

/** Like dailyLogPath, for readers: null instead of throwing, and no mkdir. */
export function existingDailyLogPath(memoriesDir: string, date: string): string | null {
  const dir = path.join(memoriesDir, "daily");
  if (isSymlink(dir)) return null;
  const file = path.join(dir, `${date}.md`);
  try {
    return fs.lstatSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * File names (YYYY-MM-DD.md) of the regular daily logs, ascending. Symlinks
 * are skipped, and a symlinked daily/ lists nothing.
 */
export function listDailyLogNames(memoriesDir: string): string[] {
  const dir = path.join(memoriesDir, "daily");
  if (isSymlink(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
