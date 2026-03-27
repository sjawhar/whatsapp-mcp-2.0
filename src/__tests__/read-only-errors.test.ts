import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getReadOnlyErrorMessage } from "../whatsapp.js";

describe("read-only error messages", () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-readonly-test-"));
    lockFile = path.join(tmpDir, ".whatsapp.lock");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes PID when lock file has valid PID content", () => {
    const testPid = 12345;
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(testPid));

    const message = getReadOnlyErrorMessage(lockFile);
    expect(message).toContain(`PID ${testPid}`);
    expect(message).toContain("auto-recover within 10 seconds");
  });

  it("omits PID when lock file is missing", () => {
    const message = getReadOnlyErrorMessage(lockFile);
    expect(message).toContain("another process");
    expect(message).not.toContain("PID");
    expect(message).toContain("auto-recover within 10 seconds");
  });

  it("omits PID when lock file contains non-numeric content", () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "not-a-number");

    const message = getReadOnlyErrorMessage(lockFile);
    expect(message).toContain("another process");
    expect(message).not.toContain("PID");
    expect(message).toContain("auto-recover within 10 seconds");
  });

  it("includes auto-recovery guidance in all cases", () => {
    const messageWithPid = getReadOnlyErrorMessage(lockFile);
    expect(messageWithPid).toContain("auto-recover within 10 seconds");

    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "99999");
    const messageWithValidPid = getReadOnlyErrorMessage(lockFile);
    expect(messageWithValidPid).toContain("auto-recover within 10 seconds");
  });
});
