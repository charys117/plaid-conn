import { describe, expect, it } from "vitest";
import { sanitizeWebhookPayload } from "./webhook-service";

describe("sanitizeWebhookPayload", () => {
  it("redacts token-like fields recursively", () => {
    expect(
      sanitizeWebhookPayload({
        item_id: "item-1",
        public_tokens: ["public-a"],
        nested: {
          access_token: "access-a",
          ordinary: "safe"
        }
      })
    ).toEqual({
      item_id: "item-1",
      public_tokens: "[REDACTED]",
      nested: {
        access_token: "[REDACTED]",
        ordinary: "safe"
      }
    });
  });
});
