import { useEffect, useRef } from "react";
import {
  usePlaidLink,
  type PlaidLinkOnSuccessMetadata
} from "react-plaid-link";
import { api, ApiError } from "./api";
import type { LinkFlow } from "./types";

export const LINK_FLOW_STORAGE_KEY = "plaid-conn-link-flow";

export function PlaidFlowController(props: {
  flow: LinkFlow;
  onComplete: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const openedToken = useRef<string | null>(null);
  const returningFromOAuth =
    window.location.pathname === "/oauth-return" ||
    new URLSearchParams(window.location.search).has("oauth_state_id");

  const { open, ready, error } = usePlaidLink({
    token: props.flow.linkToken,
    ...(returningFromOAuth
      ? { receivedRedirectUri: window.location.href }
      : {}),
    onSuccess: async (
      publicToken: string | null,
      metadata: PlaidLinkOnSuccessMetadata
    ) => {
      try {
        if (props.flow.mode === "update") {
          await api.completeUpdate(props.flow.sessionId);
        } else {
          if (!publicToken) {
            throw new Error("Plaid Link did not return a public token");
          }
          try {
            await api.exchange({
              sessionId: props.flow.sessionId,
              publicToken,
              metadata,
              allowDuplicate: false
            });
          } catch (exchangeError) {
            if (
              exchangeError instanceof ApiError &&
              exchangeError.status === 409 &&
              exchangeError.details &&
              window.confirm(
                "发现同一机构下名称和尾号相同的账户。仍然要创建重复连接吗？"
              )
            ) {
              await api.exchange({
                sessionId: props.flow.sessionId,
                publicToken,
                metadata,
                allowDuplicate: true
              });
            } else {
              throw exchangeError;
            }
          }
        }
        clearPersistedFlow();
        clearOAuthReturn(returningFromOAuth);
        props.onComplete();
      } catch (caught) {
        clearPersistedFlow();
        clearOAuthReturn(returningFromOAuth);
        props.onError(
          caught instanceof Error ? caught.message : "Plaid 连接保存失败"
        );
      }
    },
    onExit: (exitError) => {
      if (exitError) props.onError(exitError.display_message ?? exitError.error_message);
      clearPersistedFlow();
      clearOAuthReturn(returningFromOAuth);
      props.onCancel();
    }
  });

  useEffect(() => {
    if (error) props.onError(error.message);
  }, [error, props]);

  useEffect(() => {
    if (
      ready &&
      openedToken.current !== props.flow.linkToken
    ) {
      openedToken.current = props.flow.linkToken;
      open();
    }
  }, [open, props.flow, ready]);

  return null;
}

export function persistFlow(flow: LinkFlow): void {
  window.sessionStorage.setItem(LINK_FLOW_STORAGE_KEY, JSON.stringify(flow));
}

export function loadPersistedFlow(): LinkFlow | null {
  const raw = window.sessionStorage.getItem(LINK_FLOW_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LinkFlow>;
    if (
      typeof value.linkToken !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.expiration !== "string" ||
      (value.mode !== "create" && value.mode !== "update") ||
      new Date(value.expiration).getTime() <= Date.now()
    ) {
      clearPersistedFlow();
      return null;
    }
    return value as LinkFlow;
  } catch {
    clearPersistedFlow();
    return null;
  }
}

export function clearPersistedFlow(): void {
  window.sessionStorage.removeItem(LINK_FLOW_STORAGE_KEY);
}

function clearOAuthReturn(returningFromOAuth: boolean): void {
  if (returningFromOAuth) {
    window.history.replaceState({}, "", "/");
  }
}
