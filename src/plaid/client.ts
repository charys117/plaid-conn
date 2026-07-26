import {
  Configuration,
  PlaidApi,
  PlaidEnvironments
} from "plaid";
import type { RuntimePlaidProfile } from "../config/profiles";

export function createPlaidClient(profile: RuntimePlaidProfile): PlaidApi {
  const basePath =
    profile.environment === "production"
      ? PlaidEnvironments.production!
      : PlaidEnvironments.sandbox!;

  return new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": profile.clientId,
          "PLAID-SECRET": profile.secret,
          "Plaid-Version": "2020-09-14"
        },
        timeout: 30_000
      }
    })
  );
}
