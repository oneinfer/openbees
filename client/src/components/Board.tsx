import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { useStore, optimisticMoveTask } from '../lib/store';
import { createTask, deleteTask, moveTask } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { isBoardTask } from '../lib/taskState';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { TaskCardOverlay } from './TaskCard';

const dropAnimation = {
  duration: 200,
  easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
};

export function Board() {
  const navigate = useNavigate();
  const tasks = useStore((s) => s.tasks);
  const streamingTaskIds = useStore((s) => s.streamingTaskIds);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const grouped = useMemo(() => {
    const buckets: Record<TaskStatus, Task[]> = { pending: [], in_progress: [], in_review: [], done: [] };
    for (const t of tasks.filter(isBoardTask)) {
      if (t.status in buckets) buckets[t.status].push(t);
    }
    for (const s of TASK_STATUSES) buckets[s].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [tasks]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isFlushingPending, setIsFlushingPending] = useState(false);
  const [flushPendingError, setFlushPendingError] = useState<string | null>(null);
  const [isCreatingPullRequestTask, setIsCreatingPullRequestTask] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    const task = (event.active.data.current as { task: Task } | undefined)?.task ?? null;
    setActiveTask(task);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const targetStatus = over.id as TaskStatus;
    const task = (active.data.current as { task: Task })?.task;
    if (!task || task.status === targetStatus) return;

    await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
  }

  async function handleFlushPending() {
    if (isFlushingPending) return;

    const targets = grouped.pending;
    if (targets.length === 0) return;

    setIsFlushingPending(true);
    setFlushPendingError(null);
    try {
      const results = await Promise.allSettled(targets.map(async (task) => {
        const optimisticTask = { ...task, status: 'in_progress' as TaskStatus, updated_at: Date.now() };
        upsertTask(optimisticTask);
        try {
          const result = await moveTask(task.id, 'in_progress');
          upsertTask(result.task);
        } catch (error) {
          upsertTask(task);
          throw error;
        }
      }));

      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        setFlushPendingError(`Failed to flush ${failed} task${failed === 1 ? '' : 's'}.`);
      }
    } finally {
      setIsFlushingPending(false);
    }
  }

  async function handleCreatePullRequestWithAi() {
    if (isCreatingPullRequestTask) return;

    const targets = grouped.in_review;
    if (targets.length === 0) return;

    const workspacePaths = Array.from(
      new Set(targets.map((task) => task.workspace_path).filter((path): path is string => Boolean(path))),
    );
    const workspacePath = workspacePaths.length === 1 ? workspacePaths[0] : null;
    const taskList = targets
      .map((task) => {
        const details = [
          `id: ${task.id}`,
          task.workspace_path ? `workspace: ${task.workspace_path}` : null,
          task.description ? `notes: ${task.description}` : null,
        ].filter(Boolean).join('; ');
        return `- ${task.title}${details ? ` (${details})` : ''}`;
      })
      .join('\n');

    const description = [
      'Create a pull request for the work represented by the Ready for review tasks below.',
      '',
      'Inspect the repository state, review the relevant changes, run the appropriate verification, create a clear commit if needed, push the branch, and open a pull request with a concise title and description. Report the PR link and any verification results when finished.',
      workspacePaths.length > 1
        ? `Multiple workspaces are represented: ${workspacePaths.join(', ')}. Choose the correct repository for the pull request and explain the choice.`
        : null,
      '',
      'Ready for review tasks:',
      taskList,
    ].filter((line): line is string => line !== null).join('\n');

    setIsCreatingPullRequestTask(true);
    setPullRequestError(null);
    try {
      const created = await createTask(
        description,
        'Create pull request',
        workspacePath,
        undefined,
        undefined,
        undefined,
        'direct',
        undefined,
        'task',
      );
      upsertTask(created.task);
      const activated = await moveTask(created.task.id, 'in_progress');
      upsertTask(activated.task);
      navigate(`/tasks/${activated.task.id}`);
    } catch (error) {
      setPullRequestError(toErrorMessage(error, 'Failed to create pull request task'));
    } finally {
      setIsCreatingPullRequestTask(false);
    }
  }

  function handleRequestDeleteAll(status: TaskStatus) {
    setBulkDeleteError(null);
    setDeleteAllStatus(status);
  }

  function handleCancelDeleteAll() {
    if (isBulkDeleting) return;
    setDeleteAllStatus(null);
    setBulkDeleteError(null);
  }

  async function handleConfirmDeleteAll() {
    if (!deleteAllStatus || isBulkDeleting) return;

    const targets = grouped[deleteAllStatus];
    if (targets.length === 0) {
      handleCancelDeleteAll();
      return;
    }

    setIsBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const results = await Promise.allSettled(targets.map((task) => deleteTask(task.id)));
      let failed = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          removeTask(targets[index].id);
        } else {
          failed += 1;
        }
      });

      if (failed === 0) {
        setDeleteAllStatus(null);
      } else {
        setBulkDeleteError(`Failed to delete ${failed} task${failed === 1 ? '' : 's'}.`);
      }
    } finally {
      setIsBulkDeleting(false);
    }
  }

  const deleteAllTasks = deleteAllStatus ? grouped[deleteAllStatus] : [];
  const deleteAllLabel = deleteAllStatus ? STATUS_META[deleteAllStatus].label : '';
  const deleteAllCount = deleteAllTasks.length;
  const deleteAllTaskWord = deleteAllCount === 1 ? 'task' : 'tasks';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-6 p-6 overflow-x-auto flex-1 min-h-0">
        {TASK_STATUSES.map((status, index) => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status]}
            streamingTaskIds={streamingTaskIds}
            isLast={index === TASK_STATUSES.length - 1}
            onRequestDeleteAll={handleRequestDeleteAll}
            onFlushPending={handleFlushPending}
            isFlushingPending={isFlushingPending}
            onCreatePullRequestWithAi={handleCreatePullRequestWithAi}
            isCreatingPullRequestTask={isCreatingPullRequestTask}
          />
        ))}
      </div>
      {flushPendingError && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-lg dark:border-red-900/70 dark:bg-red-950 dark:text-red-300">
          {flushPendingError}
        </div>
      )}
      {pullRequestError && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-lg dark:border-red-900/70 dark:bg-red-950 dark:text-red-300">
          {pullRequestError}
        </div>
      )}
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask && (
          <TaskCardOverlay
            task={activeTask}
            isStreaming={streamingTaskIds.has(activeTask.id)}
          />
        )}
      </DragOverlay>
      {deleteAllStatus && (
        <DeleteConfirmModal
          title={`Delete ${deleteAllCount} ${deleteAllLabel} ${deleteAllTaskWord}?`}
          body={
            deleteAllCount === 1
              ? `This removes the task in ${deleteAllLabel} from Bees. The Hermes session history remains in Hermes.`
              : `This removes every task in ${deleteAllLabel} from Bees. Hermes session histories remain in Hermes.`
          }
          confirmLabel={deleteAllCount === 1 ? 'Delete task' : `Delete ${deleteAllCount} tasks`}
          isConfirming={isBulkDeleting}
          error={bulkDeleteError}
          onConfirm={handleConfirmDeleteAll}
          onCancel={handleCancelDeleteAll}
        />
      )}
    </DndContext>
  );
}
