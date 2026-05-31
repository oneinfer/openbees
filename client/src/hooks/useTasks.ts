import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchCurrentProject, fetchProjects, fetchTasks } from '../lib/api';
import { announceTaskCreated } from '../lib/taskNotification';

export function useTasks() {
  const setProjects = useStore((s) => s.setProjects);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const removeProject = useStore((s) => s.removeProject);
  const setTasks = useStore((s) => s.setTasks);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const setStreamingTasks = useStore((s) => s.setStreamingTasks);
  const setTaskStreaming = useStore((s) => s.setTaskStreaming);
  const retryRef = useRef(0);

  useEffect(() => {
    fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
  }, [setTasks]);

  useEffect(() => {
    fetchProjects().then((res) => setProjects(res.projects)).catch(console.error);
  }, [setProjects]);

  useEffect(() => {
    fetchCurrentProject()
      .then((res) => setCurrentProjectPath(res.workspacePath))
      .catch((error) => {
        console.error(error);
        setCurrentProjectPath(useStore.getState().currentProjectPath);
      });
  }, [setCurrentProjectPath]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      es = new EventSource('/api/events');

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
          fetchProjects().then((res) => setProjects(res.projects)).catch(console.error);
        }
        retryRef.current = 0;
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          if (event.type === 'task_created' || event.type === 'task_updated') {
            upsertTask(event.task);
            if (event.type === 'task_created') {
              const verb = event.task.status === 'in_progress' ? 'created and started in In Progress' : 'created';
              announceTaskCreated(`Task has been ${verb}: ${event.task.title}`, event.task.id);
            }
          } else if (event.type === 'task_deleted') {
            removeTask(event.taskId);
          } else if (event.type === 'project_saved') {
            upsertProject(event.project);
          } else if (event.type === 'project_deleted') {
            removeProject(event.path, event.taskIds);
          } else if (event.type === 'task_runs_snapshot') {
            setStreamingTasks(event.runs.filter((r) => r.status === 'streaming').map((r) => r.taskId));
          } else if (event.type === 'task_run_updated') {
            setTaskStreaming(event.run.taskId, event.run.status === 'streaming');
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [setProjects, setTasks, upsertProject, removeProject, upsertTask, removeTask, setStreamingTasks, setTaskStreaming]);
}
