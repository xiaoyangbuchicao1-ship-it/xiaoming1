import { useState } from "react";
import type { Task, TaskEffort, TaskPriority, UpdateTaskInput } from "../shared/task.ts";

type FilterTab = "all" | "pending" | "today" | "done";

interface TaskBoardProps {
  tasks: Task[];
  loading: boolean;
  error: string;
  onUpdateTask: (id: string, changes: UpdateTaskInput) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onQuickPrompt: (prompt: string) => void;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "高优先",
  medium: "中优先",
  low: "低优先",
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const EFFORT_LABEL: Record<TaskEffort, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

function getLocalToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function asPriority(value: unknown): TaskPriority | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function asEffort(value: unknown): TaskEffort | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
}

function priorityRank(task: Task): number {
  const priority = asPriority(task.priority);
  return priority ? PRIORITY_RANK[priority] : 3;
}

function sortPending(list: Task[]): Task[] {
  return [...list].sort((a, b) => priorityRank(a) - priorityRank(b));
}

export function TaskBoard({
  tasks,
  loading,
  error,
  onUpdateTask,
  onDeleteTask,
  onQuickPrompt,
}: TaskBoardProps) {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const today = getLocalToday();

  const pendingCount = tasks.filter((t) => !t.done).length;
  const overdueTasks = tasks.filter((t) => !t.done && Boolean(t.dueDate && t.dueDate < today));
  const todayTasks = tasks.filter((t) => !t.done && t.dueDate === today);
  const regularPending = sortPending(
    tasks.filter((t) => !t.done && (!t.dueDate || t.dueDate > today)),
  );
  const doneTasks = tasks.filter((t) => t.done);

  async function runAction(id: string, fn: () => Promise<void>) {
    if (busyId) return;
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  function renderTaskRow(task: Task) {
    const priority = asPriority(task.priority);
    const effort = asEffort(task.effort);
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const doneSubCount = subtasks.filter((s) => s.done).length;
    const isOverdue = !task.done && Boolean(task.dueDate && task.dueDate < today);
    const isToday = !task.done && task.dueDate === today;
    const allSubDone = subtasks.length > 0 && doneSubCount === subtasks.length && !task.done;

    return (
      <li key={task.id} className={`board-item${task.done ? " is-done" : ""}`}>
        <div className="board-row">
          <button
            type="button"
            className={`check-btn${task.done ? " checked" : ""}`}
            aria-label={
              task.done ? `将「${task.title}」标为未完成` : `将「${task.title}」标为已完成`
            }
            disabled={busyId === task.id}
            onClick={() =>
              void runAction(task.id, () => onUpdateTask(task.id, { done: !task.done }))
            }
          >
            {task.done ? "✓" : ""}
          </button>

          <div className="board-content">
            <span className="board-title">{task.title}</span>
            {(priority || effort || task.dueDate || subtasks.length > 0 || allSubDone) && (
              <div className="board-meta">
                {priority && (
                  <span className={`pill pill-p-${priority}`}>{PRIORITY_LABEL[priority]}</span>
                )}
                {effort && <span className="pill pill-effort">工作量:{EFFORT_LABEL[effort]}</span>}
                {task.dueDate && (
                  <span
                    className={`pill ${
                      isOverdue ? "pill-overdue" : isToday ? "pill-today" : "pill-date"
                    }`}
                  >
                    {isOverdue ? `逾期 ${task.dueDate}` : isToday ? "今天到期" : task.dueDate}
                  </span>
                )}
                {subtasks.length > 0 && (
                  <span className="pill pill-sub">
                    子任务 {doneSubCount}/{subtasks.length}
                  </span>
                )}
                {allSubDone && <span className="pill pill-ready">子任务全完成</span>}
              </div>
            )}
          </div>

          <button
            type="button"
            className="delete-btn"
            aria-label={`删除「${task.title}」`}
            disabled={busyId === task.id}
            onClick={() => void runAction(task.id, () => onDeleteTask(task.id))}
          >
            ×
          </button>
        </div>

        {subtasks.length > 0 && (
          <ul className="subtask-list">
            {subtasks.map((sub) => (
              <li key={sub.id} className={`subtask-row${sub.done ? " is-done" : ""}`}>
                <button
                  type="button"
                  className={`check-btn check-sm${sub.done ? " checked" : ""}`}
                  aria-label={
                    sub.done ? `取消完成子任务「${sub.title}」` : `完成子任务「${sub.title}」`
                  }
                  disabled={busyId === task.id}
                  onClick={() =>
                    void runAction(task.id, () =>
                      onUpdateTask(task.id, {
                        subtasks: subtasks.map((item) =>
                          item.id === sub.id ? { ...item, done: !item.done } : item,
                        ),
                      }),
                    )
                  }
                >
                  {sub.done ? "✓" : ""}
                </button>
                <span>{sub.title}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  function renderGroup(label: string, items: Task[], tone?: "danger" | "today" | "muted") {
    if (items.length === 0) return null;
    return (
      <section className="board-group">
        <header className={`board-group-head${tone ? ` tone-${tone}` : ""}`}>
          <span>{label}</span>
          <span>{items.length}</span>
        </header>
        <ul className="board-list">{items.map(renderTaskRow)}</ul>
      </section>
    );
  }

  const hasVisibleTasks =
    filter === "all"
      ? tasks.length > 0
      : filter === "pending"
        ? pendingCount > 0
        : filter === "today"
          ? todayTasks.length > 0 || overdueTasks.length > 0
          : doneTasks.length > 0;

  return (
    <aside className="board" aria-label="实时待办看板">
      <div className="board-head">
        <div>
          <h2>实时清单</h2>
          <p>
            {pendingCount} 项待处理
            {overdueTasks.length > 0 ? ` · ${overdueTasks.length} 项已逾期` : ""}
          </p>
        </div>
        <div className="board-tabs" role="tablist" aria-label="任务筛选">
          {(
            [
              ["all", "全部"],
              ["pending", "待办"],
              ["today", "今日"],
              ["done", "已完成"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="board-error" role="alert">
          {error}
        </p>
      )}

      <div className="board-scroll">
        {loading && tasks.length === 0 ? (
          <p className="board-empty">正在加载清单…</p>
        ) : !hasVisibleTasks ? (
          <div className="board-empty">
            <p>暂无对应任务</p>
            <button
              type="button"
              className="board-cta"
              onClick={() => onQuickPrompt("帮我记一下买牛奶，今天到期，高优先级")}
            >
              试试让小明记一条任务 ↗
            </button>
          </div>
        ) : filter === "all" ? (
          <>
            {renderGroup("已逾期", overdueTasks, "danger")}
            {renderGroup("今日到期", todayTasks, "today")}
            {renderGroup("待办", regularPending)}
            {renderGroup("已完成", doneTasks, "muted")}
          </>
        ) : filter === "pending" ? (
          <>
            {renderGroup("已逾期", overdueTasks, "danger")}
            {renderGroup("今日到期", todayTasks, "today")}
            {renderGroup("后续待办", regularPending)}
          </>
        ) : filter === "today" ? (
          <>
            {renderGroup("已逾期提醒", overdueTasks, "danger")}
            {renderGroup("今日到期", todayTasks, "today")}
          </>
        ) : (
          renderGroup("已完成", doneTasks, "muted")
        )}
      </div>
    </aside>
  );
}
