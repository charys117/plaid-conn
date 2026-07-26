export type Profile = {
  id: string;
  displayName: string;
  environment: "sandbox" | "production";
  countryCodes: string[];
  daysRequested: number;
  enabled: boolean;
};

export type Account = {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string | null;
  currentBalance: string | null;
  hidden: boolean;
};

export type Item = {
  id: string;
  profileId: string;
  institutionName: string | null;
  status:
    | "active"
    | "syncing"
    | "login_required"
    | "error"
    | "disabled";
  consentExpirationAt: string | null;
  lastSyncSucceededAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  accounts: Account[];
};

export type LinkTokenResponse = {
  linkToken: string;
  sessionId: string;
  expiration: string;
};

export type LinkFlow = LinkTokenResponse & {
  mode: "create" | "update";
};
