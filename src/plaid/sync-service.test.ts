import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config/env";
import { TokenCipher } from "../security/token-cipher";
import type { RegisteredPlaidProfile } from "./profile-registry";
import { PlaidSyncService } from "./sync-service";

type FetchAllPages = (
  profile: RegisteredPlaidProfile,
  accessToken: string,
  cursor: string | null
) => Promise<{
  added: Array<{ transaction_id: string }>;
  modified: unknown[];
  removed: unknown[];
  cursor: string;
  pages: number;
}>;

function serviceWith(transactionsSync: ReturnType<typeof vi.fn>) {
  const service = new PlaidSyncService(
    {} as never,
    {} as never,
    new TokenCipher(randomBytes(32)),
    {
      syncMaxBackoffMinutes: 60
    } as AppConfig
  );
  const profile = {
    client: { transactionsSync }
  } as unknown as RegisteredPlaidProfile;
  const fetchAllPages = (
    service as unknown as { fetchAllPages: FetchAllPages }
  ).fetchAllPages.bind(service);
  return { fetchAllPages, profile };
}

function page(input: {
  added?: string[];
  cursor: string;
  hasMore: boolean;
  requestId: string;
}) {
  return {
    data: {
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      accounts: [],
      added: (input.added ?? []).map((transactionId) => ({
        transaction_id: transactionId
      })),
      modified: [],
      removed: [],
      next_cursor: input.cursor,
      has_more: input.hasMore,
      request_id: input.requestId
    }
  };
}

describe("PlaidSyncService pagination", () => {
  it("collects every page and returns only the terminal cursor", async () => {
    const transactionsSync = vi
      .fn()
      .mockResolvedValueOnce(
        page({ added: ["tx-1"], cursor: "cursor-1", hasMore: true, requestId: "r1" })
      )
      .mockResolvedValueOnce(
        page({ added: ["tx-2"], cursor: "cursor-2", hasMore: false, requestId: "r2" })
      );
    const { fetchAllPages, profile } = serviceWith(transactionsSync);

    const result = await fetchAllPages(profile, "access", null);

    expect(result.added.map((transaction) => transaction.transaction_id)).toEqual([
      "tx-1",
      "tx-2"
    ]);
    expect(result.cursor).toBe("cursor-2");
    expect(result.pages).toBe(2);
    expect(transactionsSync.mock.calls[1]?.[0]).toMatchObject({
      cursor: "cursor-1"
    });
  });

  it("restarts the entire loop from the original cursor after a mutation error", async () => {
    const mutationError = {
      response: {
        status: 400,
        data: {
          error_type: "TRANSACTIONS_ERROR",
          error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          error_message: "mutated"
        }
      }
    };
    const transactionsSync = vi
      .fn()
      .mockResolvedValueOnce(
        page({ added: ["discard-me"], cursor: "cursor-1", hasMore: true, requestId: "r1" })
      )
      .mockRejectedValueOnce(mutationError)
      .mockResolvedValueOnce(
        page({ added: ["kept"], cursor: "cursor-final", hasMore: false, requestId: "r3" })
      );
    const { fetchAllPages, profile } = serviceWith(transactionsSync);

    const result = await fetchAllPages(profile, "access", null);

    expect(result.added.map((transaction) => transaction.transaction_id)).toEqual([
      "kept"
    ]);
    expect(transactionsSync.mock.calls[2]?.[0].cursor).toBeUndefined();
  });
});
