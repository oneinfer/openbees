import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAgentDefaults, fetchAgentModels, fetchAgentRuntimes, fetchTaskAgentSettings, updateActivityAgentSettings } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import { readCachedAgentDefaults, writeCachedAgentDefaults } from '../lib/agentDefaultsCache';
import type { AgentDefaults, AgentModelGroup, AgentRuntime, AgentRuntimeOption, ReasoningEffort } from '@shared/types';

const FALLBACK_DEFAULTS: AgentDefaults = {
  runtime: 'hermes',
  provider: null,
  model: null,
  baseUrl: null,
  apiMode: null,
  reasoningEffort: null,
  showReasoning: false,
};

export function useAgentConfig(taskId?: string, initialSettings?: AgentRunSettings) {
  const [defaults, setDefaults] = useState<AgentDefaults>(() => readCachedAgentDefaults() ?? FALLBACK_DEFAULTS);
  const [runtimeOptions, setRuntimeOptions] = useState<AgentRuntimeOption[]>([]);
  const [runtime, setRuntime] = useState<AgentRuntime | null>(initialSettings?.runtime ?? null);
  const [modelGroups, setModelGroups] = useState<AgentModelGroup[]>([]);
  const [runtimeDefaultModel, setRuntimeDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(initialSettings?.model ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(initialSettings?.reasoningEffort ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const initialRef = useRef(initialSettings);

  const refreshRuntimes = useCallback(async () => {
    const result = await fetchAgentRuntimes();
    setRuntimeOptions(result.options);
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    function loadConfig(isRetry = false) {
      if (!isRetry) setIsLoading(true);
      Promise.allSettled([
        taskId ? fetchTaskAgentSettings(taskId) : fetchAgentDefaults(),
        fetchAgentRuntimes(),
      ]).then(([settingsResult, runtimesResult]) => {
        if (cancelled) return;

        let allSucceeded = true;
        if (settingsResult.status === 'fulfilled') {
          const val = settingsResult.value;
          if ('task' in val) {
            writeCachedAgentDefaults(val.defaults);
            setDefaults(val.defaults);
            setRuntime(val.task.runtime ?? initialRef.current?.runtime ?? null);
            setModel(val.task.model ?? initialRef.current?.model ?? null);
            setReasoningEffort(val.task.reasoningEffort ?? initialRef.current?.reasoningEffort ?? null);
            setRuntimeOptions(val.runtimes.options);
          } else {
            writeCachedAgentDefaults(val);
            setDefaults(val);
            setRuntime(initialRef.current?.runtime ?? val.runtime ?? null);
          }
        } else {
          allSucceeded = false;
        }

        if (runtimesResult.status === 'fulfilled') {
          setRuntimeOptions(runtimesResult.value.options);
        } else {
          allSucceeded = false;
        }

        if (!isRetry) setIsLoading(false);
        if (!allSucceeded) {
          timeoutId = window.setTimeout(() => loadConfig(true), 2000);
        }
      });
    }

    loadConfig();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [taskId]);

  const effectiveRuntime = runtime ?? defaults?.runtime ?? 'hermes';

  useEffect(() => {
    if (isLoading) return;
    void updateActivityAgentSettings({
      runtime: effectiveRuntime,
      model,
      reasoningEffort,
    }).catch(() => {
      // Activity capture is best-effort; normal task/chat runtime selection still works.
    });
  }, [effectiveRuntime, isLoading, model, reasoningEffort]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    function loadModels() {
      fetchAgentModels(effectiveRuntime)
        .then((result) => {
          if (cancelled) return;
          setModelGroups(result.groups);
          setRuntimeDefaultModel(result.defaultModel);
        })
        .catch(() => {
          if (cancelled) return;
          setModelGroups([]);
          setRuntimeDefaultModel(null);
          timeoutId = window.setTimeout(loadModels, 2000);
        });
    }

    loadModels();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [effectiveRuntime]);

  useEffect(() => {
    if (effectiveRuntime !== 'opencode') return;
    if (!model) return;
    if (modelGroups.some((group) => group.models.some((option) => option.id === model))) return;
    if (modelGroups.length === 0) return;
    setModel(null);
  }, [effectiveRuntime, model, modelGroups]);

  const setRuntimeWithReset = useCallback((nextRuntime: AgentRuntime | null) => {
    setRuntime(nextRuntime);
    setModel(null);
    setReasoningEffort(null);
  }, []);

  const replaceDefaults = useCallback((d: AgentDefaults) => {
    writeCachedAgentDefaults(d);
    setDefaults(d);
    if (!taskId) setRuntime(initialRef.current?.runtime ?? d.runtime ?? null);
  }, [taskId]);

  return {
    defaults,
    runtimeOptions,
    runtime,
    setRuntime: setRuntimeWithReset,
    modelGroups,
    runtimeDefaultModel,
    model,
    setModel,
    reasoningEffort,
    setReasoningEffort,
    isLoading,
    replaceDefaults,
    refreshRuntimes,
  };
}
