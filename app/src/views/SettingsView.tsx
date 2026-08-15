import { useEffect, useState } from 'react'
import { tauri, type HubConfigValues } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { Button } from '@/components/ui/button'
import { SUPPORTED_LANGS, useTranslation } from '@/i18n'

/** FIELDS key → i18n settings.* key 的映射（i18n 里 hub_host/hub_port/hub_path 带 hub_ 前缀）。 */
const LABEL_KEY: Record<string, string> = {
  host: 'hub_host',
  port: 'hub_port',
  path: 'hub_path',
  max_queue: 'max_queue',
  history_limit: 'history_limit',
  wait_timeout_ms: 'wait_timeout_ms',
  default_wait_ms: 'default_wait_ms',
  connected_window_ms: 'connected_window_ms',
  peer_idle_timeout_ms: 'peer_idle_timeout_ms',
  herdr_bin: 'herdr_bin',
  herdr_timeout_ms: 'herdr_timeout_ms'
}

const FIELDS: Array<{
  key: keyof HubConfigValues
  type: 'text' | 'number'
}> = [
  { key: 'host', type: 'text' },
  { key: 'port', type: 'number' },
  { key: 'path', type: 'text' },
  { key: 'max_queue', type: 'number' },
  { key: 'history_limit', type: 'number' },
  { key: 'wait_timeout_ms', type: 'number' },
  { key: 'default_wait_ms', type: 'number' },
  { key: 'connected_window_ms', type: 'number' },
  { key: 'peer_idle_timeout_ms', type: 'number' },
  { key: 'herdr_bin', type: 'text' },
  { key: 'herdr_timeout_ms', type: 'number' }
]

/**
 * 配置面板：12 项 hub 启动参数 + SQLite 持久化 + 应用并重启。
 */
export function SettingsView(): React.JSX.Element {
  const { t, lang, setLang } = useTranslation()
  const [values, setValues] = useState<HubConfigValues | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [serviceBusy, setServiceBusy] = useState<boolean>(false)
  const [serviceOutput, setServiceOutput] = useState<string | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)
  // hub CLI 工具（版本 / 检查更新 / 更新 / 安装 / setup 配置 agents）
  const [hubToolBusy, setHubToolBusy] = useState<boolean>(false)
  const [cliVersion, setCliVersion] = useState<string | null>(null)
  /** CLI 是否可用（--version 成功）；false = 未安装，显示安装入口。 */
  const [cliInstalled, setCliInstalled] = useState<boolean>(true)
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; outdated: boolean } | null>(null)
  const [hubToolError, setHubToolError] = useState<string | null>(null)
  const [hubToolOutput, setHubToolOutput] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const raw = await tauri.invoke.configGet()
        // HubConfigValues 是 Rust 返回 JSON object（snake_case keys）。
        setValues({
          host: String(raw.host ?? '127.0.0.1'),
          port: Number(raw.port ?? 18764),
          path: String(raw.path ?? '/mcp'),
          max_queue: Number(raw.max_queue ?? 200),
          history_limit: Number(raw.history_limit ?? 100),
          wait_timeout_ms: Number(raw.wait_timeout_ms ?? 60_000),
          default_wait_ms: Number(raw.default_wait_ms ?? 30_000),
          connected_window_ms: Number(raw.connected_window_ms ?? 30_000),
          peer_idle_timeout_ms: Number(raw.peer_idle_timeout_ms ?? 600_000),
          herdr_bin: String(raw.herdr_bin ?? ''),
          herdr_timeout_ms: Number(raw.herdr_timeout_ms ?? 30_000)
        })
      } catch (e) {
        setError(serializeError(e))
      } finally {
        setLoading(false)
      }
    })()
    // 进入设置页时自动读取本地 hub CLI 版本
    void loadCliVersion()
  }, [])

  const update = <K extends keyof HubConfigValues>(key: K, val: HubConfigValues[K]): void => {
    if (values === null) return
    setValues({ ...values, [key]: val })
  }

  const handleSave = async (): Promise<void> => {
    if (values === null) return
    setSaving(true)
    setError(null)
    try {
      await tauri.invoke.configSet(values as unknown as Record<string, unknown>)
      setSavedAt(Date.now())
      // 应用并重启
      await tauri.invoke.hubRestartWithSavedConfig()
    } catch (e) {
      setError(serializeError(e))
    } finally {
      setSaving(false)
    }
  }

  const handleService = async (action: 'install' | 'uninstall'): Promise<void> => {
    setServiceBusy(true)
    setServiceError(null)
    setServiceOutput(null)
    try {
      const res =
        action === 'install'
          ? await tauri.invoke.serviceInstall()
          : await tauri.invoke.serviceUninstall()
      setServiceOutput(res.output === '' ? `service ${action}: ok` : res.output)
    } catch (e) {
      setServiceError(serializeError(e))
    } finally {
      setServiceBusy(false)
    }
  }

  /** 读取本地 hub CLI 版本（启动时自动 + 手动刷新）。失败 = 未安装。 */
  const loadCliVersion = async (): Promise<void> => {
    setHubToolBusy(true)
    setHubToolError(null)
    try {
      const res = await tauri.invoke.hubCliVersion()
      setCliVersion(res.version)
      setCliInstalled(true)
    } catch (e) {
      setCliVersion(null)
      setCliInstalled(false)
      setHubToolError(serializeError(e))
    } finally {
      setHubToolBusy(false)
    }
  }

  /** 安装 hub CLI：npm install -g agent-comm-hub。 */
  const installHubCli = async (): Promise<void> => {
    setHubToolBusy(true)
    setHubToolError(null)
    setHubToolOutput(null)
    try {
      const res = await tauri.invoke.hubCliInstall()
      setHubToolOutput(res.output === '' ? 'install: ok' : res.output)
      // 安装成功后重新检测版本
      await loadCliVersion()
    } catch (e) {
      setHubToolError(serializeError(e))
    } finally {
      setHubToolBusy(false)
    }
  }

  /** 配置本地 agents：agent-comm-hub setup（检测 + 安装 SKILL + 写 MCP 配置）。 */
  const runSetup = async (): Promise<void> => {
    setHubToolBusy(true)
    setHubToolError(null)
    setHubToolOutput(null)
    try {
      const res = await tauri.invoke.hubCliSetup()
      setHubToolOutput(res.output === '' ? 'setup: ok' : res.output)
    } catch (e) {
      setHubToolError(serializeError(e))
    } finally {
      setHubToolBusy(false)
    }
  }

  /** 检查更新：npm view agent-comm-hub version vs 本地 CLI 版本。 */
  const checkUpdate = async (): Promise<void> => {
    setHubToolBusy(true)
    setHubToolError(null)
    setUpdateInfo(null)
    try {
      const res = await tauri.invoke.hubCliCheckUpdate()
      if (res.current !== '') setCliVersion(res.current)
      setUpdateInfo({ latest: res.latest, outdated: res.outdated })
    } catch (e) {
      setUpdateInfo(null)
      setHubToolError(serializeError(e))
    } finally {
      setHubToolBusy(false)
    }
  }

  /** 更新 hub：agent-comm-hub update（npm 重装全局包，输出展示）。 */
  const runUpdate = async (): Promise<void> => {
    setHubToolBusy(true)
    setHubToolError(null)
    setHubToolOutput(null)
    try {
      const res = await tauri.invoke.hubCliUpdate()
      setHubToolOutput(res.output === '' ? 'update: ok' : res.output)
      // 更新后刷新版本显示
      void loadCliVersion()
    } catch (e) {
      setHubToolError(serializeError(e))
    } finally {
      setHubToolBusy(false)
    }
  }

  if (loading || values === null) {
    return (
      <div className="rounded-md border bg-card p-4 text-xs text-muted-foreground">
        {t('settings.loading_config')}
      </div>
    )
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <h3 className="text-sm font-semibold text-foreground">{t('settings.title')}</h3>
        {/* 语言切换（SPEC AC-11：切换立即生效 + localStorage 持久化） */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{t('settings.language')}:</span>
          <div className="flex overflow-hidden rounded-md border border-border">
            {SUPPORTED_LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  lang === l
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t(`settings.${l}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {savedAt !== null && (
            <span className="text-xs text-success">
              {t('settings.saved_at')} {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
          {error !== null && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t(`settings.${LABEL_KEY[f.key]}`)}
              <span className="ml-1 font-normal text-muted-foreground/70">
                · {t(`settings.hints.${f.key}`)}
              </span>
            </label>
            <input
              type={f.type}
              value={String(values[f.key])}
              onChange={(e) => {
                const v =
                  f.type === 'number'
                    ? (Number(e.target.value) as HubConfigValues[typeof f.key])
                    : (e.target.value as HubConfigValues[typeof f.key])
                update(f.key, v)
              }}
              className="rounded-md border bg-background px-2 py-1 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t p-3">
        <Button variant="outline" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('settings.saving_and_restarting') : t('settings.save_and_restart')}
        </Button>
      </div>

      {/* 开机自启（PRD F-13 / SPEC AC-9） */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">{t('settings.auto_start')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Windows Run key / Linux systemd / macOS launchd（
              <code className="rounded bg-background px-1 py-px font-mono text-[10px]">
                agent-comm-hub service install|uninstall
              </code>
              ）
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={serviceBusy}
              onClick={() => void handleService('install')}
            >
              {serviceBusy ? t('common.loading') : t('settings.auto_start_install')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={serviceBusy}
              onClick={() => void handleService('uninstall')}
            >
              {t('settings.auto_start_uninstall')}
            </Button>
          </div>
        </div>
        {serviceError !== null && (
          <p className="mt-2 break-all font-mono text-[11px] text-destructive">{serviceError}</p>
        )}
        {serviceOutput !== null && serviceError === null && (
          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground/80">
            {serviceOutput}
          </pre>
        )}
      </div>

      {/* Hub 工具：安装 / 版本 / 检查更新 / 更新 / 配置 agents（agent-comm-hub CLI 管理） */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">{t('settings.hub_tools')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.hub_tools_desc')}（
              <code className="rounded bg-background px-1 py-px font-mono text-[10px]">
                agent-comm-hub --version / update / setup
              </code>
              ）
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {!cliInstalled ? (
              <Button
                variant="default"
                size="sm"
                disabled={hubToolBusy}
                onClick={() => void installHubCli()}
              >
                {hubToolBusy ? t('common.loading') : t('settings.hub_install')}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={hubToolBusy}
                  onClick={() => void loadCliVersion()}
                >
                  {t('settings.hub_refresh_version')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={hubToolBusy}
                  onClick={() => void checkUpdate()}
                >
                  {t('settings.hub_check_update')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  disabled={hubToolBusy}
                  onClick={() => void runUpdate()}
                >
                  {hubToolBusy ? t('common.loading') : t('settings.hub_update')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={hubToolBusy}
                  onClick={() => void runSetup()}
                >
                  {t('settings.hub_setup_agents')}
                </Button>
              </>
            )}
          </div>
        </div>
        {!cliInstalled && (
          <p className="mt-2 font-mono text-[11px] text-warning">
            {t('settings.hub_not_installed')}
          </p>
        )}
        {cliVersion !== null && (
          <p className="mt-2 font-mono text-[11px] text-foreground/80">
            {t('settings.hub_current_version')}: {cliVersion}
          </p>
        )}
        {updateInfo !== null && hubToolError === null && (
          <p
            className={`mt-1 font-mono text-[11px] ${
              updateInfo.outdated ? 'text-warning' : 'text-success'
            }`}
          >
            {t('settings.hub_latest_version')}: {updateInfo.latest}
            {updateInfo.outdated
              ? ` · ${t('settings.hub_outdated_hint')}`
              : ` · ${t('settings.hub_up_to_date')}`}
          </p>
        )}
        {hubToolError !== null && (
          <p className="mt-2 break-all font-mono text-[11px] text-destructive">{hubToolError}</p>
        )}
        {hubToolOutput !== null && hubToolError === null && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2 font-mono text-[11px] text-foreground/80">
            {hubToolOutput}
          </pre>
        )}
      </div>

      {/* 底部：应用版本 */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          agent-comm-hub-app v{__APP_VERSION__}
        </span>
      </div>
    </div>
  )
}