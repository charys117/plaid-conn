import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { safeStringEqual, TokenCipher } from "./token-cipher";

describe("TokenCipher", () => {
  it("round-trips a token with authenticated associated data", () => {
    const cipher = new TokenCipher(randomBytes(32));
    const encrypted = cipher.encrypt("access-production-secret", "profile:item");

    expect(encrypted).not.toContain("access-production-secret");
    expect(cipher.decrypt(encrypted, "profile:item")).toBe(
      "access-production-secret"
    );
  });

  it("rejects ciphertext moved to a different Item", () => {
    const cipher = new TokenCipher(randomBytes(32));
    const encrypted = cipher.encrypt("access-token", "profile:item-a");

    expect(() => cipher.decrypt(encrypted, "profile:item-b")).toThrow();
  });
});

describe("safeStringEqual", () => {
  it("compares equal values without accepting different lengths", () => {
    expect(safeStringEqual("same", "same")).toBe(true);
    expect(safeStringEqual("same", "different")).toBe(false);
  });
});
