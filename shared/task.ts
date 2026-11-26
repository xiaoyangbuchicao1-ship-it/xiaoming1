import { z } from "zod";

export const taskPrioritySchema = z.enum(["high", "medium", "low"]);
export const taskEffortSchema = z.enum(["small", "medium", "large"]);

export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式需为 YYYY-MM-DD")
  .refine((val) => {
    const parsed = new Date(`${val}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(val);
  }, "请输入有效日历日期");

export const titleSchema = z.string().trim().min(1).max(200);

export const subtaskSchema = z.object({
  id: z.string().min(1),
  title: titleSchema,
  done: z.boolean(),
});

export const subtaskInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: titleSchema,
  done: z.boolean().optional(),
});

export const createTaskInputSchema = z.strictObject({
  title: titleSchema,
  dueDate: dueDateSchema.nullable().optional(),
  priority: taskPrioritySchema.nullable().optional(),
  effort: taskEffortSchema.nullable().optional(),
  subtasks: z.array(subtaskInputSchema).max(50).optional(),
});

export const updateTaskInputSchema = z
  .strictObject({
    title: titleSchema.optional(),
    done: z.boolean().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    priority: taskPrioritySchema.nullable().optional(),
    effort: taskEffortSchema.nullable().optional(),
    subtasks: z.array(subtaskInputSchema).max(50).optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "至少需要提供一个要更新的字段。",
  });

export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskEffort = z.infer<typeof taskEffortSchema>;
export type Subtask = z.infer<typeof subtaskSchema>;
export type SubtaskInput = z.infer<typeof subtaskInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export interface Task {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: TaskPriority;
  effort?: TaskEffort;
  subtasks?: Subtask[];
  [key: string]: unknown;
}
