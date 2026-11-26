import { Router } from "express";
import { createTaskInputSchema, updateTaskInputSchema } from "../shared/task.ts";
import type { TaskStore } from "./task-store.ts";

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskInputSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的任务标题（1 至 200 个字符）及可选属性。" });
    }
    res.status(201).json(tasks.create(input.data));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskInputSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的任务更新字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
