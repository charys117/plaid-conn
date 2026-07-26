export type ParsedPlaidError = {
  errorType: string;
  errorCode: string;
  message: string;
  requestId?: string;
  statusCode?: number;
};

export function parsePlaidError(error: unknown): ParsedPlaidError {
  const fallback: ParsedPlaidError = {
    errorType: "UNKNOWN",
    errorCode: "UNKNOWN",
    message: error instanceof Error ? error.message : "Unknown Plaid error"
  };

  if (!error || typeof error !== "object") return fallback;
  const candidate = error as {
    response?: {
      status?: number;
      data?: Record<string, unknown>;
    };
    message?: string;
  };
  const data = candidate.response?.data;
  if (!data) return fallback;

  return {
    errorType:
      typeof data.error_type === "string" ? data.error_type : "UNKNOWN",
    errorCode:
      typeof data.error_code === "string" ? data.error_code : "UNKNOWN",
    message:
      typeof data.error_message === "string"
        ? data.error_message
        : candidate.message ?? "Unknown Plaid error",
    ...(typeof data.request_id === "string"
      ? { requestId: data.request_id }
      : {}),
    ...(typeof candidate.response?.status === "number"
      ? { statusCode: candidate.response.status }
      : {})
  };
}

export function isLoginRequired(error: ParsedPlaidError): boolean {
  return [
    "ITEM_LOGIN_REQUIRED",
    "PENDING_EXPIRATION",
    "PENDING_DISCONNECT"
  ].includes(error.errorCode);
}
