import fs from "fs";
import path from "path";

/**
 * Atomically acquire a file lock for the WhatsApp connection.
 * Uses O_CREAT | O_EXCL to prevent race conditions between processes.
 * Only one process should connect to WhatsApp at a time to avoid status 515/440.
 *
 * @param lockFilePath - Path to the lock file
 * @returns true if lock was acquired, false if another live process holds it
 */
export function acquireWhatsAppLock(lockFilePath: string): boolean {
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });

  try {
    // Atomic create — throws EEXIST if file already exists (no race window)
    const fd = fs.openSync(
      lockFilePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }

    // File exists — check if the owning process is still alive
    const pid = parseInt(fs.readFileSync(lockFilePath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // throws if process is dead
      return false; // another instance is alive
    } catch {
      // Stale lock — remove and retry once
      console.error(`Stale lock file found (PID ${pid} is dead) — clearing and taking over`);
      fs.unlinkSync(lockFilePath);

      try {
        const fd = fs.openSync(
          lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch {
        // Another process beat us to the retry — they win
        return false;
      }
    }
  }
}

/**
 * Release the lock file, but only if this process owns it.
 *
 * @param lockFilePath - Path to the lock file
 */
export function releaseWhatsAppLock(lockFilePath: string): void {
  try {
    if (fs.existsSync(lockFilePath)) {
      const pid = parseInt(fs.readFileSync(lockFilePath, "utf-8").trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(lockFilePath);
      }
    }
  } catch {
    // Best-effort release — don't crash during shutdown
  }
}
