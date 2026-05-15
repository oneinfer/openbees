import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAgentDefaults, fetchAgentModels, fetchAgentRuntimes, fetchTaskAgentSettings } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import { readCachedAgentDefaults, writeCachedAgentDefaults } from '../lib/agentDefaultsCache';
import type { AgentDefaults, AgentModelGroup, AgentRuntime, AgentRuntimeOption, ReasoningEffort } from '@shared/types';

export function useAgentConfig(taskId?: string, initialSettings?: AgentRunSettings) {
  const [defaults, setDefaults] = useState<AgentDefaults | null>(() => readCachedAgentDefaults());
  const [runtimeOptions, setRuntimeOptions] = useState<AgentRuntimeOption[]>([]);
  const [runtime, setRuntime] = useState<AgentRuntime | null>(initialSettings?.runtime ?? null);
  const [modelGroups, setModelGroups] = useState<AgentModelGroup[]>([]);
  const [runtimeDefaultModel, setRuntimeDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(initialSettings?.model ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(initialSettings?.reasoningEffort ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const initialRef = useRef(initialSettings);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.allSettled([
      taskId ? fetchTaskAgentSettings(taskId) : fetchAgentDefaults(),
      fetchAgentRuntimes(),
    ]).then(([settingsResult, runtimesResult]) => {
      if (cancelled) return;
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
      }
      if (runtimesResult.status === 'fulfilled') {
        setRuntimeOptions(runtimesResult.value.options);
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  const effectiveRuntime = runtime ?? defaults?.runtime ?? 'hermes';

  useEffect(() => {
    let cancelled = false;
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
      });
    return () => { cancelled = true; };
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
  }, []);

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
  };
}
