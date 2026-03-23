import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWhatsAppLock, releaseWhatsAppLock } from "../lock.js";

describe("lock file", () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-lock-test-"));
    lockFile = path.join(tmpDir, ".whatsapp.lock");
  });

  afterEach(() => {
    // Clean up: release if owned, then remove temp dir
    try {
      releaseWhatsAppLock(lockFile);
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires lock on first call and writes current PID", () => {
    expect(acquireWhatsAppLock(lockFile)).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(true);
    const pid = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it("two rapid calls — exactly one succeeds", () => {
    const first = acquireWhatsAppLock(lockFile);
    const second = acquireWhatsAppLock(lockFile);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("stale lock with dead PID — new process takes over", () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "99999999");

    const result = acquireWhatsAppLock(lockFile);
    expect(result).toBe(true);
    const pid = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it("release removes the lock file when owned by current PID", () => {
    acquireWhatsAppLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(true);
    releaseWhatsAppLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("release is safe when no lock file exists", () => {
    expect(() => releaseWhatsAppLock(lockFile)).not.toThrow();
  });

  it("release does not remove lock owned by different PID", () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "99999999");
    releaseWhatsAppLock(lockFile);
    // File should still exist — not our PID
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("creates parent directories if they don't exist", () => {
    const nested = path.join(tmpDir, "deep", "nested", ".whatsapp.lock");
    expect(acquireWhatsAppLock(nested)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });
});
