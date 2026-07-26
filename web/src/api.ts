import type {
  Item,
  LinkTokenResponse,
  Profile
} from "./types";

export const AUTH_REQUIRED_EVENT = "plaid-conn:auth-required";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    const error = new ApiError(
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? `Request failed with status ${response.status}`,
      body.error?.details
    );
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  getSession: () =>
    request<{ authenticated: boolean }>("/api/auth/session"),

  login: (password: string) =>
    request<{ authenticated: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    }),

  logout: () =>
    request<{ authenticated: boolean }>("/api/auth/logout", {
      method: "POST"
    }),

  getProfiles: () =>
    request<{ profiles: Profile[] }>("/api/profiles"),

  getItems: () => request<{ items: Item[] }>("/api/items"),

  createLinkToken: (profileId: string) =>
    request<LinkTokenResponse>(`/api/profiles/${profileId}/link-token`, {
      method: "POST"
    }),

  createUpdateLinkToken: (itemId: string) =>
    request<LinkTokenResponse>(`/api/items/${itemId}/update-link-token`, {
      method: "POST"
    }),

  exchange: (
    input: {
      sessionId: string;
      publicToken: string;
      metadata: unknown;
      allowDuplicate: boolean;
    }
  ) =>
    request<{ itemId: string; institutionName: string | null }>(
      "/api/link/exchange",
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    ),

  completeUpdate: (sessionId: string) =>
    request<{ accepted: boolean }>("/api/link/update-complete", {
      method: "POST",
      body: JSON.stringify({ sessionId })
    }),

  requestSync: (itemId: string) =>
    request<{ accepted: boolean }>(`/api/items/${itemId}/sync`, {
      method: "POST"
    }),

  removeItem: (itemId: string) =>
    request<void>(`/api/items/${itemId}`, { method: "DELETE" }),

  setAccountHidden: (accountId: string, hidden: boolean) =>
    request<{ updated: boolean }>(`/api/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ hidden })
    })
};
