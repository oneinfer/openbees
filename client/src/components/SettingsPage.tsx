import { useCallback, useEffect, useState } from 'react';
import { Bot, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { updateAgentDefaults } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { ModelPicker, REASONING_LABELS } from './InputToolbar';
import {
  REASONING_EFFORTS,
  type AgentRuntime,
  type ReasoningEffort,
} from '@shared/types';

const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  const { defaults: agentDefaults, runtimeOptions, modelGroups, runtimeDefaultModel, isLoading: isLoadingDefaults, replaceDefaults } = useAgentConfig();
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [savedDefaults, setSavedDefaults] = useState(false);
  const [modelDraft, setModelDraft] = useState('');

  useEffect(() => {
    if (!savedDefaults) return;
    const timer = setTimeout(() => setSavedDefaults(false), 2000);
    return () => clearTimeout(timer);
  }, [savedDefaults]);

  const defaultRuntime = agentDefaults?.runtime ?? 'hermes';
  const runtimeMeta = runtimeOptions.find((option) => option.id === defaultRuntime);
  const modelControl = runtimeMeta?.modelControl ?? 'picker';
  const reasoningControl = runtimeMeta?.reasoningControl ?? 'picker';
  const shouldUsePicker = modelControl === 'picker' && (defaultRuntime === 'hermes' || modelGroups.length > 0);
  const shouldUseTextField = modelControl === 'text' || (modelControl === 'picker' && defaultRuntime !== 'hermes' && modelGroups.length === 0);

  useEffect(() => {
    setModelDraft(agentDefaults?.model ?? '');
  }, [agentDefaults?.model]);

  const saveDefaults = useCallback(async (updates: { runtime?: AgentRuntime | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) => {
    setSavingDefaults(true);
    setDefaultsError(null);
    setSavedDefaults(false);
    try {
      const result = await updateAgentDefaults(updates);
      replaceDefaults(result);
      setSavedDefaults(true);
    } catch (error) {
      setDefaultsError(toErrorMessage(error, 'Failed to save'));
    } finally {
      setSavingDefaults(false);
    }
  }, [replaceDefaults]);

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Runtime bridge</h2>
          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 gap-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
              <Bot size={14} />
              Multi-runtime bridge
            </div>
          </div>
          <p className="mt-2 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
            Tasks can run through Hermes, Codex, Claude Code, or OpenCode. Hermes uses the built-in model catalog; external CLIs can take a typed model id and repo-scoped task context.
          </p>
        </div>

        <section
          aria-labelledby="default-runtime-title"
          className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="default-runtime-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Default runtime
              </h2>
              <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
                New tasks start with this coding runtime. Hermes supports model and reasoning overrides; external runtimes use their own configured CLI behavior.
              </p>
            </div>
            <span
              aria-live="polite"
              aria-hidden={!defaultsError && !savingDefaults && !savedDefaults}
              className={`shrink-0 text-xs transition-opacity duration-300 ${
                defaultsError || savingDefaults || savedDefaults ? 'opacity-100' : 'opacity-0'
              } ${defaultsError ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}`}
            >
              {defaultsError ?? (savingDefaults ? 'Saving...' : 'Saved')}
            </span>
          </div>

          <div className="mt-4 flex items-center flex-wrap gap-3">
            <select
              value={defaultRuntime}
              disabled={isLoadingDefaults || savingDefaults}
              onChange={(event) => saveDefaults({ runtime: event.target.value as AgentRuntime })}
              aria-label="Default runtime"
              className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-700 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%2371717a%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m3%204.5%203%203%203-3%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat"
            >
              {runtimeOptions.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>
                  {runtime.status === 'ready' ? runtime.label : `${runtime.label} (Configure)`}
                </option>
              ))}
            </select>

            {shouldUsePicker && (
              <ModelPicker
                value={agentDefaults?.model ?? ''}
                defaultModel={runtimeDefaultModel}
                modelGroups={modelGroups}
                disabled={isLoadingDefaults || savingDefaults}
                title={agentDefaults?.model ? `Default: ${agentDefaults.model}` : 'Select default model'}
                showInheritOption={false}
                onChange={(nextModel) => saveDefaults({ model: nextModel || null })}
              />
            )}

            {shouldUseTextField && (
              <input
                value={modelDraft}
                disabled={isLoadingDefaults || savingDefaults}
                onChange={(event) => setModelDraft(event.target.value)}
                onBlur={() => {
                  const next = modelDraft.trim();
                  if ((agentDefaults?.model ?? '') === next) return;
                  void saveDefaults({ model: next || null });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  (event.currentTarget as HTMLInputElement).blur();
                }}
                placeholder="Default model id"
                aria-label="Default model id"
                className="h-9 min-w-[12rem] rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-700"
              />
            )}

            {reasoningControl === 'picker' && (
              <select
                value={agentDefaults?.reasoningEffort ?? 'medium'}
                disabled={isLoadingDefaults || savingDefaults}
                onChange={(event) => saveDefaults({ reasoningEffort: event.target.value as ReasoningEffort })}
                aria-label="Default reasoning effort"
                className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-700 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%2371717a%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m3%204.5%203%203%203-3%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat"
              >
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {REASONING_LABELS[effort]}
                  </option>
                ))}
              </select>
            )}

            {modelControl === 'none' && reasoningControl === 'none' && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                This runtime uses only its command configuration.
              </span>
            )}
          </div>
        </section>

        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Theme</h2>
          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 gap-1">
            {themeOptions.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  theme === value
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
