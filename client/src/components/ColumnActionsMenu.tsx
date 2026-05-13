import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';

interface Props {
  x: number;
  y: number;
  columnLabel: string;
  taskCount: number;
  onClose: () => void;
  onDeleteAll: () => void;
}

export function ColumnActionsMenu({ x, y, columnLabel, taskCount, onClose, onDeleteAll }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const hasTasks = taskCount > 0;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPos({
      x: x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : x,
      y: y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : y,
    });
  }, [x, y]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  function handleDeleteAll() {
    if (!hasTasks) return;
    onDeleteAll();
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[220px] py-1 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-xl animate-in fade-in zoom-in-95 duration-100"
    >
      <button
        type="button"
        role="menuitem"
        onClick={handleDeleteAll}
        disabled={!hasTasks}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:cursor-not-allowed disabled:text-zinc-400 dark:disabled:text-zinc-600 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:hover:bg-transparent"
      >
        <Trash2 size={14} />
        {hasTasks ? `Delete all in ${columnLabel}...` : 'No tasks to delete'}
      </button>
    </div>,
    document.body,
  );
}
