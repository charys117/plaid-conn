import { useCallback, useEffect, useMemo, useState } from "react";
import { api, AUTH_REQUIRED_EVENT } from "./api";
import {
  clearPersistedFlow,
  loadPersistedFlow,
  persistFlow,
  PlaidFlowController
} from "./PlaidFlowController";
import type { Account, Item, LinkFlow, Profile } from "./types";

type Notice = { type: "success" | "error"; message: string };

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [linkFlow, setLinkFlow] = useState<LinkFlow | null>(() =>
    loadPersistedFlow()
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileResponse, itemResponse] = await Promise.all([
        api.getProfiles(),
        api.getItems()
      ]);
      setProfiles(profileResponse.profiles);
      setItems(itemResponse.items);
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "数据加载失败"
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void api
      .getSession()
      .then((session) => {
        setAuthenticated(session.authenticated);
        if (session.authenticated) void loadData();
        else setLoading(false);
      })
      .catch(() => {
        setAuthenticated(false);
        setLoading(false);
      });
  }, [loadData]);

  useEffect(() => {
    const requireAuthentication = () => {
      clearPersistedFlow();
      setAuthenticated(false);
      setLinkFlow(null);
      setProfiles([]);
      setItems([]);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
  }, []);

  const itemsByProfile = useMemo(() => {
    const grouped = new Map<string, Item[]>();
    for (const item of items) {
      grouped.set(item.profileId, [
        ...(grouped.get(item.profileId) ?? []),
        item
      ]);
    }
    return grouped;
  }, [items]);

  const startCreate = async (profileId: string) => {
    await runBusy(`profile:${profileId}`, async () => {
      const token = await api.createLinkToken(profileId);
      const flow: LinkFlow = { ...token, mode: "create" };
      persistFlow(flow);
      setLinkFlow(flow);
    });
  };

  const startUpdate = async (itemId: string) => {
    await runBusy(`update:${itemId}`, async () => {
      const token = await api.createUpdateLinkToken(itemId);
      const flow: LinkFlow = { ...token, mode: "update" };
      persistFlow(flow);
      setLinkFlow(flow);
    });
  };

  const runBusy = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "操作失败"
      });
    } finally {
      setBusyKey(null);
    }
  };

  if (authenticated === null || (loading && profiles.length === 0)) {
    return <LoadingScreen />;
  }
  if (!authenticated) {
    return (
      <Login
        onAuthenticated={() => {
          setAuthenticated(true);
          void loadData();
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PC</div>
          <div>
            <strong>Plaid Connector</strong>
            <span>PostgreSQL 同步控制台</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="button button-ghost"
            onClick={() => void loadData()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新状态"}
          </button>
          <button
            className="button button-ghost"
            onClick={() => {
              void api
                .logout()
                .catch(() => undefined)
                .finally(() => {
                  clearPersistedFlow();
                  setLinkFlow(null);
                  setProfiles([]);
                  setItems([]);
                  setAuthenticated(false);
                });
            }}
          >
            退出
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">CONNECTION OVERVIEW</p>
            <h1>把每个账户可靠地同步到 PostgreSQL</h1>
            <p className="hero-copy">
              Profile 隔离 Plaid 凭证，Item 保存独立 cursor。这里仅管理连接和同步，不承担数据展示。
            </p>
          </div>
          <div className="hero-stats">
            <Stat label="Plaid Profiles" value={profiles.length} />
            <Stat label="Active Items" value={items.filter((item) => item.status === "active").length} />
            <Stat label="Accounts" value={items.reduce((sum, item) => sum + item.accounts.length, 0)} />
          </div>
        </section>

        {notice && (
          <div className={`notice notice-${notice.type}`} role="status">
            {notice.message}
            <button aria-label="关闭提示" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}

        <section className="profile-grid">
          {profiles.map((profile) => (
            <ProfilePanel
              key={profile.id}
              profile={profile}
              items={itemsByProfile.get(profile.id) ?? []}
              busyKey={busyKey}
              onAdd={() => void startCreate(profile.id)}
              onUpdate={(itemId) => void startUpdate(itemId)}
              onSync={(itemId) =>
                void runBusy(`sync:${itemId}`, async () => {
                  await api.requestSync(itemId);
                  setNotice({
                    type: "success",
                    message: "同步任务已加入队列"
                  });
                  await loadData();
                })
              }
              onRemove={(item) => {
                if (
                  window.confirm(
                    `确认断开 ${item.institutionName ?? "此连接"}？Plaid 访问权限会被撤销，已同步的历史数据会保留。`
                  )
                ) {
                  void runBusy(`remove:${item.id}`, async () => {
                    await api.removeItem(item.id);
                    await loadData();
                    setNotice({ type: "success", message: "连接已移除" });
                  });
                }
              }}
              onToggleAccount={(account) =>
                void runBusy(`account:${account.id}`, async () => {
                  await api.setAccountHidden(account.id, !account.hidden);
                  await loadData();
                })
              }
            />
          ))}
        </section>
      </main>

      {linkFlow && (
        <PlaidFlowController
          flow={linkFlow}
          onComplete={() => {
            setLinkFlow(null);
            setNotice({ type: "success", message: "Plaid 连接已保存" });
            void loadData();
          }}
          onCancel={() => setLinkFlow(null)}
          onError={(message) => {
            setLinkFlow(null);
            setNotice({ type: "error", message });
          }}
        />
      )}
    </div>
  );
}

function ProfilePanel(props: {
  profile: Profile;
  items: Item[];
  busyKey: string | null;
  onAdd: () => void;
  onUpdate: (itemId: string) => void;
  onSync: (itemId: string) => void;
  onRemove: (item: Item) => void;
  onToggleAccount: (account: Account) => void;
}) {
  return (
    <article className="profile-panel">
      <header className="profile-header">
        <div>
          <div className="profile-title-line">
            <h2>{props.profile.displayName}</h2>
            <span className={`environment environment-${props.profile.environment}`}>
              {props.profile.environment}
            </span>
          </div>
          <p>
            {props.profile.countryCodes.join(", ")} · 最多{" "}
            {props.profile.daysRequested} 天历史
          </p>
        </div>
        <button
          className="button button-primary"
          disabled={
            !props.profile.enabled ||
            props.busyKey === `profile:${props.profile.id}`
          }
          onClick={props.onAdd}
        >
          {props.busyKey === `profile:${props.profile.id}`
            ? "准备 Link…"
            : "添加连接"}
        </button>
      </header>

      {props.items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">↗</span>
          <strong>还没有 Item</strong>
          <p>点击“添加连接”，通过 Plaid Link 关联第一个金融机构。</p>
        </div>
      ) : (
        <div className="item-list">
          {props.items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              busyKey={props.busyKey}
              onUpdate={() => props.onUpdate(item.id)}
              onSync={() => props.onSync(item.id)}
              onRemove={() => props.onRemove(item)}
              onToggleAccount={props.onToggleAccount}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function ItemCard(props: {
  item: Item;
  busyKey: string | null;
  onUpdate: () => void;
  onSync: () => void;
  onRemove: () => void;
  onToggleAccount: (account: Account) => void;
}) {
  const item = props.item;
  const consentWarning =
    item.consentExpirationAt &&
    new Date(item.consentExpirationAt).getTime() <=
      Date.now() + 14 * 24 * 60 * 60 * 1000;
  return (
    <section className="item-card">
      <div className="item-summary">
        <div className="institution-icon">
          {(item.institutionName ?? "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="item-heading">
          <div>
            <h3>{item.institutionName ?? "未知机构"}</h3>
            <StatusPill status={item.status} />
          </div>
          <p>
            最近同步：
            {item.lastSyncSucceededAt
              ? formatDate(item.lastSyncSucceededAt)
              : "尚未完成"}
          </p>
        </div>
        <div className="item-actions">
          <button
            className="button button-small"
            onClick={props.onSync}
            disabled={
              props.busyKey === `sync:${item.id}` ||
              item.status === "syncing" ||
              item.status === "disabled" ||
              item.status === "login_required"
            }
          >
            {item.status === "syncing"
              ? "同步中"
              : item.status === "login_required"
                ? "请先认证"
                : "立即同步"}
          </button>
          <button
            className="button button-small"
            onClick={props.onUpdate}
            disabled={item.status === "disabled"}
          >
            重新认证
          </button>
          <button
            className="button button-small button-danger"
            onClick={props.onRemove}
            disabled={props.busyKey === `remove:${item.id}`}
          >
            移除
          </button>
        </div>
      </div>

      {item.lastErrorCode && (
        <div className="item-error">
          <strong>{item.lastErrorCode}</strong>
          <span>{item.lastErrorMessage}</span>
        </div>
      )}

      {consentWarning && (
        <div className="item-error">
          <strong>授权即将到期</strong>
          <span>请在 {formatDate(item.consentExpirationAt!)} 前重新认证。</span>
        </div>
      )}

      <div className="account-table">
        <div className="account-row account-header">
          <span>账户</span>
          <span>类型</span>
          <span>最近余额</span>
          <span>数据状态</span>
        </div>
        {item.accounts.map((account) => (
          <div
            className={`account-row ${account.hidden ? "account-hidden" : ""}`}
            key={account.id}
          >
            <span>
              <strong>{account.name}</strong>
              <small>{account.mask ? `•••• ${account.mask}` : "无尾号"}</small>
            </span>
            <span>
              {account.type}
              {account.subtype ? ` / ${account.subtype}` : ""}
            </span>
            <span>
              {formatMoney(account.currentBalance, account.currency)}
            </span>
            <span>
              <button
                className="visibility-toggle"
                onClick={() => props.onToggleAccount(account)}
                disabled={props.busyKey === `account:${account.id}`}
              >
                {account.hidden ? "已隐藏 · 显示" : "可查询 · 隐藏"}
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: Item["status"] }) {
  const labels: Record<Item["status"], string> = {
    active: "正常",
    syncing: "同步中",
    login_required: "需要认证",
    error: "同步异常",
    disabled: "已停用"
  };
  return <span className={`status status-${status}`}>{labels[status]}</span>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void api
            .login(password)
            .then(onAuthenticated)
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : "登录失败")
            )
            .finally(() => setBusy(false));
        }}
      >
        <div className="brand-mark brand-mark-large">PC</div>
        <p className="eyebrow">PRIVATE CONNECTOR</p>
        <h1>管理你的 Plaid 连接</h1>
        <p>使用部署时设置的管理员密码进入。</p>
        <label>
          管理员密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="button button-primary button-wide" disabled={busy}>
          {busy ? "验证中…" : "进入控制台"}
        </button>
      </form>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-page">
      <div className="loading-dot" />
      <span>正在连接服务…</span>
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatMoney(value: string | null, currency: string | null): string {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (currency?.length === 3) {
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency
      }).format(number);
    } catch {
      // Fall through to a plain number for unofficial currency codes.
    }
  }
  return `${number.toFixed(2)} ${currency ?? ""}`.trim();
}
