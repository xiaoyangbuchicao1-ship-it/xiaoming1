import type { Task, UpdateTaskInput } from "../shared/task.ts";

async function parseError(response: Response): Promise<never> {
  let message = "任务请求失败，请稍后重试。";
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      message = body.error;
    }
  } catch {
    // 忽略非 JSON 错误体，保留默认报错提示
  }
  throw new Error(message);
}

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch("/api/tasks");
  if (!response.ok) return parseError(response);
  return (await response.json()) as Task[];
}

export async function patchTask(id: string, changes: UpdateTaskInput): Promise<Task> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!response.ok) return parseError(response);
  return (await response.json()) as Task;
}

export async function removeTask(id: string): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) return parseError(response);
}
