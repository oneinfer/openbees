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
import { isBoardTask, taskStatusesForScope } from '../lib/taskState';
import { useOrganizations } from '../auth/OrganizationContext';
import { primeTaskCreatedNotifications } from '../lib/taskNotification';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StartTaskDialog } from './StartTaskDialog';
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
  const { selectedOrganizationId } = useOrganizations();
  const boardStatuses = useMemo(() => taskStatusesForScope(selectedOrganizationId), [selectedOrganizationId]);
  const grouped = useMemo(() => {
    const buckets = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as Task[]])) as unknown as Record<TaskStatus, Task[]>;
    for (const t of tasks.filter(isBoardTask)) {
      const status = (t.status === 'assigned' && !selectedOrganizationId) ? 'pending' : t.status;
      if (status in buckets) buckets[status].push(t);
    }
    for (const s of TASK_STATUSES) buckets[s].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [tasks, selectedOrganizationId]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isFlushingPending, setIsFlushingPending] = useState(false);
  const [flushPendingError, setFlushPendingError] = useState<string | null>(null);
  const [isCreatingPullRequestTask, setIsCreatingPullRequestTask] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [startQueue, setStartQueue] = useState<{
    tasks: Task[];
    index: number;
    source: 'single' | 'flush';
    navigateOnStarted?: boolean;
  } | null>(null);

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

    if ((task.status === 'pending' || task.status === 'assigned') && targetStatus === 'in_progress') {
      if (task.organization_id) {
        setStartQueue({ tasks: [task], index: 0, source: 'single' });
      } else {
        await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
        navigate(`/tasks/${task.id}`);
      }
      return;
    }

    await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
  }

  function handleRequestStart(task: Task) {
    if (task.organization_id) {
      setStartQueue({ tasks: [task], index: 0, source: 'single' });
    } else {
      void optimisticMoveTask(task, 'in_progress', upsertTask, moveTask).then(() => {
        navigate(`/tasks/${task.id}`);
      });
    }
  }

  function closeStartQueue() {
    setStartQueue(null);
    setIsFlushingPending(false);
  }

  function advanceStartQueue() {
    setStartQueue((current) => {
      if (!current) return null;
      const nextIndex = current.index + 1;
      if (nextIndex >= current.tasks.length) {
        setIsFlushingPending(false);
        return null;
      }
      return { ...current, index: nextIndex };
    });
  }

  function handleStartedTask(task: Task) {
    upsertTask(task);
    const navigateToStarted = startQueue?.navigateOnStarted;
    advanceStartQueue();
    if (navigateToStarted) navigate(`/tasks/${task.id}`);
  }

  function handleFlushPending() {
    if (isFlushingPending) return;

    const targets = grouped.pending;
    if (targets.length === 0) return;

    setIsFlushingPending(true);
    setFlushPendingError(null);

    const personalTasks = targets.filter((t) => !t.organization_id);
    const orgTasks = targets.filter((t) => t.organization_id);

    for (const task of personalTasks) {
      void optimisticMoveTask(task, 'in_progress', upsertTask, moveTask);
    }

    if (orgTasks.length > 0) {
      setStartQueue({ tasks: orgTasks, index: 0, source: 'flush' });
    } else {
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
    primeTaskCreatedNotifications();
    try {
      const created = await createTask(
        description,
        'Create pull request',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'task',
      );
      upsertTask(created.task);
      setStartQueue({ tasks: [created.task], index: 0, source: 'single', navigateOnStarted: true });
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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 gap-6 overflow-x-auto p-6">
          {boardStatuses.map((status, index) => (
            <Column
              key={status}
              status={status}
              tasks={grouped[status]}
              streamingTaskIds={streamingTaskIds}
              isLast={index === boardStatuses.length - 1}
              onRequestDeleteAll={handleRequestDeleteAll}
              onFlushPending={handleFlushPending}
              isFlushingPending={isFlushingPending}
              onCreatePullRequestWithAi={handleCreatePullRequestWithAi}
              isCreatingPullRequestTask={isCreatingPullRequestTask}
              onRequestStart={handleRequestStart}
            />
          ))}
        </div>
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
      {startQueue && startQueue.tasks[startQueue.index] && (
        <StartTaskDialog
          key={startQueue.tasks[startQueue.index].id}
          task={startQueue.tasks[startQueue.index]}
          title={startQueue.source === 'flush' ? 'Flush pending task' : 'Start task'}
          queueLabel={startQueue.source === 'flush' ? `${startQueue.index + 1} of ${startQueue.tasks.length}` : undefined}
          onStarted={handleStartedTask}
          onSkip={startQueue.source === 'flush' ? advanceStartQueue : undefined}
          onClose={closeStartQueue}
        />
      )}
    </DndContext>
  );
}
