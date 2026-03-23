import { describe, expect, it } from "vitest";
import { validateApiUrl } from "../utils.js";

describe("validateApiUrl", () => {
  // --- Valid URLs ---
  it("accepts https Groq API URL", () => {
    const result = validateApiUrl("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("accepts https OpenAI API URL", () => {
    const result = validateApiUrl("https://api.openai.com/v1/audio/transcriptions");
    expect(result).toBeInstanceOf(URL);
  });

  it("accepts http URL to public host", () => {
    const result = validateApiUrl("http://api.example.com/v1/transcribe");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("http:");
  });

  // --- Protocol rejection ---
  it("rejects file:// protocol", () => {
    expect(() => validateApiUrl("file:///etc/passwd")).toThrow("Only http/https URLs allowed");
  });

  it("rejects ftp:// protocol", () => {
    expect(() => validateApiUrl("ftp://evil.com/file")).toThrow("Only http/https URLs allowed");
  });

  it("rejects javascript: protocol", () => {
    expect(() => validateApiUrl("javascript:alert(1)")).toThrow();
  });

  // --- Localhost rejection ---
  it("rejects localhost hostname", () => {
    expect(() => validateApiUrl("http://localhost:8080/")).toThrow("localhost not allowed");
  });

  it("rejects 127.0.0.1", () => {
    expect(() => validateApiUrl("http://127.0.0.1:8080/")).toThrow("localhost not allowed");
  });

  it("rejects ::1 (IPv6 loopback)", () => {
    expect(() => validateApiUrl("http://[::1]:8080/")).toThrow("localhost not allowed");
  });

  // --- Private IP rejection ---
  it("rejects 10.x.x.x (class A private)", () => {
    expect(() => validateApiUrl("http://10.0.0.1/")).toThrow("Private/internal IP");
  });

  it("rejects 172.16.x.x (class B private)", () => {
    expect(() => validateApiUrl("http://172.16.0.1/")).toThrow("Private/internal IP");
  });

  it("rejects 172.31.255.255 (class B private upper bound)", () => {
    expect(() => validateApiUrl("http://172.31.255.255/")).toThrow("Private/internal IP");
  });

  it("accepts 172.15.0.1 (not in private range)", () => {
    const result = validateApiUrl("http://172.15.0.1/");
    expect(result).toBeInstanceOf(URL);
  });

  it("accepts 172.32.0.1 (not in private range)", () => {
    const result = validateApiUrl("http://172.32.0.1/");
    expect(result).toBeInstanceOf(URL);
  });

  it("rejects 192.168.x.x (class C private)", () => {
    expect(() => validateApiUrl("http://192.168.1.1/")).toThrow("Private/internal IP");
  });

  it("rejects 169.254.169.254 (cloud metadata / link-local)", () => {
    expect(() => validateApiUrl("http://169.254.169.254/")).toThrow("Private/internal IP");
  });

  // --- Invalid URLs ---
  it("rejects completely invalid URL", () => {
    expect(() => validateApiUrl("not-a-url")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateApiUrl("")).toThrow();
  });
});
