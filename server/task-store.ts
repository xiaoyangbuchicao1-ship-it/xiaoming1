import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  CreateTaskInput,
  Subtask,
  SubtaskInput,
  Task,
  UpdateTaskInput,
} from "../shared/task.ts";

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);

export interface TaskStore {
  list(): Task[];
  create(input: string | CreateTaskInput): Task;
  update(id: string, changes: UpdateTaskInput): Task | undefined;
  remove(id: string): boolean;
}

function normalizeSubtasks(items: SubtaskInput[]): Subtask[] {
  return items.map((item) => ({
    id: item.id ?? randomUUID(),
    title: item.title,
    done: item.done ?? false,
  }));
}

function applyOptionalField<K extends "dueDate" | "priority" | "effort">(
  target: Task,
  key: K,
  value: Task[K] | null | undefined,
) {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8"))) as Task[];
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(input) {
      const data: CreateTaskInput = typeof input === "string" ? { title: input } : input;
      const task: Task = { id: randomUUID(), title: data.title, done: false };
      applyOptionalField(task, "dueDate", data.dueDate);
      applyOptionalField(task, "priority", data.priority);
      applyOptionalField(task, "effort", data.effort);
      if (data.subtasks && data.subtasks.length > 0) {
        task.subtasks = normalizeSubtasks(data.subtasks);
      }
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      if (changes.title !== undefined) task.title = changes.title;
      if (changes.done !== undefined) task.done = changes.done;
      applyOptionalField(task, "dueDate", changes.dueDate);
      applyOptionalField(task, "priority", changes.priority);
      applyOptionalField(task, "effort", changes.effort);
      if (changes.subtasks !== undefined) {
        if (changes.subtasks.length === 0) {
          delete task.subtasks;
        } else {
          task.subtasks = normalizeSubtasks(changes.subtasks);
        }
      }

      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
