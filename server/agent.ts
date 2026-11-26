import { join } from "node:path";
import type OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import {
  createTaskInputSchema,
  dueDateSchema,
  subtaskInputSchema,
  taskEffortSchema,
  taskPrioritySchema,
  titleSchema,
} from "../shared/task.ts";
import { getModelClient, model as defaultModel } from "./model.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ModelClient {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParams): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

export interface AgentOptions {
  tasks: TaskStore;
  getClient?: () => ModelClient;
  modelName?: string;
  now?: () => Date;
  maxSteps?: number;
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const listTasksArgsSchema = z.strictObject({
  filter: z
    .enum(["all", "pending", "done", "due_today", "overdue"])
    .optional()
    .describe("可选筛选条件，默认为 all"),
});

const updateTaskArgsSchema = z
  .strictObject({
    id: z.string().min(1).describe("来自 list_tasks 的真实任务 ID"),
    title: titleSchema.optional().describe("新任务标题"),
    done: z.boolean().optional().describe("是否已完成"),
    dueDate: dueDateSchema.nullable().optional().describe("截止日期 YYYY-MM-DD，传 null 可清除"),
    priority: taskPrioritySchema.nullable().optional().describe("优先级，传 null 可清除"),
    effort: taskEffortSchema.nullable().optional().describe("工作量，传 null 可清除"),
    subtasks: z
      .array(subtaskInputSchema)
      .max(50)
      .optional()
      .describe(
        "完整子任务列表（更新子任务时请保留未改动子任务的原有 id/title/done，不要丢失已有项）",
      ),
  })
  .refine(
    ({ id: _id, ...changes }) => Object.keys(changes).length > 0,
    "至少需要提供一个要更新的字段。",
  );

const deleteTaskArgsSchema = z.strictObject({
  id: z.string().min(1).describe("来自 list_tasks 的真实任务 ID"),
});

function buildSystemPrompt(now: Date): string {
  const today = formatLocalDate(now);
  const weekday = WEEKDAYS[now.getDay()];

  return [
    "你是「小明智能体」，一个高效、可靠、用中文管理待办清单的助手。回复应简洁清晰、直给重点。",
    `当前本地日期：${today}（${weekday}）。请以此基准换算「今天 / 明天 / 后天 / 本周五 / 下周一」等相对日期为 YYYY-MM-DD。`,
    "",
    "你必须严格遵守以下工作准则：",
    "1. 真实事实源：不要仅凭聊天历史猜测任务 ID、内容或状态（用户可能刷新过页面或直接在界面操作过）。凡涉及查看、标记完成、修改、删除或查询到期任务，必须先调用 list_tasks 获取最新清单。",
    "2. 歧义与空值处理：若有多条未完成任务都可能匹配用户描述（例如同时有「买纯牛奶」和「买酸奶」，用户说「牛奶买好了」），禁止擅自猜测修改，必须列出候选项向用户确认；若找不到匹配任务，必须如实说明未找到，严禁编造操作成功。标记任务完成后请准确表达「已完成」及「当前是否还有剩余未完成待办」，不要说「清单已清空」，以免用户误以为任务被删除。",
    "3. 危险操作刹车：遇到「清空所有任务 / 删除全部」等批量删除请求时，先列出将被删除的任务并请用户确认，切勿直接全删。",
    "4. 子任务与父任务独立：勾选或完成子任务时，只更新 subtasks 内对应项的 done，不要擅自把父任务也标为完成；如果全部子任务都已完成且父任务仍未完成，可在回复中顺便提示用户是否一并完成主任务。",
    "5. 扩展属性与纯文本展示：用户提到时间、急缓、工作量或拆分步骤时，主动提取 dueDate / priority / effort / subtasks；未提及的字段不要强行编造。前端聊天框按纯文本渲染，请勿使用 **加粗**、## 标题等 Markdown 语法，改用 emoji、缩进与符号排版。展示清单时按「⚠️ 已逾期 → 📅 今日到期 → 📋 待办（按优先级 high > medium > low 排序）→ ✅ 已完成」分组呈现（仅展示非空分组），标清状态、标签与子任务进度（如 1/2）。回答「今天有哪些任务到期？」时，列出今日到期任务，如有更早的已逾期未完成任务也一并提醒。",
  ].join("\n");
}

function toOpenAITool(name: string, description: string, schema: z.ZodType): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: z.toJSONSchema(schema, { target: "draft-07" }) as Record<string, unknown>,
    },
  };
}

export function createAgent({
  tasks,
  getClient = getModelClient,
  modelName = defaultModel,
  now = () => new Date(),
  maxSteps = 6,
}: AgentOptions): (messages: ChatMessage[]) => Promise<string> {
  const toolRegistry = {
    list_tasks: {
      schema: listTasksArgsSchema,
      definition: toOpenAITool(
        "list_tasks",
        "获取当前本地存储的真实任务清单与统计概览。查看、修改、完成或删除任务前必须先调用。",
        listTasksArgsSchema,
      ),
      run: ({ filter = "all" }: z.infer<typeof listTasksArgsSchema>) => {
        const today = formatLocalDate(now());
        const all = tasks.list();
        const filtered = all.filter((task) => {
          if (filter === "pending") return !task.done;
          if (filter === "done") return task.done;
          if (filter === "due_today") return task.dueDate === today;
          if (filter === "overdue")
            return !task.done && Boolean(task.dueDate && task.dueDate < today);
          return true;
        });

        return {
          today,
          filter,
          summary: {
            total: all.length,
            pending: all.filter((t) => !t.done).length,
            done: all.filter((t) => t.done).length,
            dueToday: all.filter((t) => !t.done && t.dueDate === today).length,
            overdue: all.filter((t) => !t.done && Boolean(t.dueDate && t.dueDate < today)).length,
          },
          tasks: filtered,
        };
      },
    },
    create_task: {
      schema: createTaskInputSchema,
      definition: toOpenAITool(
        "create_task",
        "创建一条新的待办任务，支持可选的截止日期、优先级、工作量与子任务。",
        createTaskInputSchema,
      ),
      run: (args: z.infer<typeof createTaskInputSchema>) => {
        return { created: tasks.create(args) };
      },
    },
    update_task: {
      schema: updateTaskArgsSchema,
      definition: toOpenAITool(
        "update_task",
        "根据 list_tasks 返回的 id 更新任务标题、完成状态、截止日期、优先级、工作量或子任务列表。",
        updateTaskArgsSchema,
      ),
      run: ({ id, ...changes }: z.infer<typeof updateTaskArgsSchema>) => {
        const updated = tasks.update(id, changes);
        if (!updated) {
          return { error: `找不到 ID 为 ${id} 的任务，请先调用 list_tasks 核对真实任务。` };
        }
        return { updated };
      },
    },
    delete_task: {
      schema: deleteTaskArgsSchema,
      definition: toOpenAITool(
        "delete_task",
        "根据 list_tasks 返回的 id 永久删除一条任务。",
        deleteTaskArgsSchema,
      ),
      run: ({ id }: z.infer<typeof deleteTaskArgsSchema>) => {
        if (!tasks.remove(id)) {
          return { error: `找不到 ID 为 ${id} 的任务，无法删除。` };
        }
        return { deletedId: id };
      },
    },
  };

  type ToolName = keyof typeof toolRegistry;
  const tools = Object.values(toolRegistry).map((entry) => entry.definition);

  return async function reply(messages: ChatMessage[]): Promise<string> {
    const client = getClient();
    const conversation: ChatCompletionMessageParam[] = [
      { role: "system", content: buildSystemPrompt(now()) },
      ...messages.map((msg) => ({ role: msg.role, content: msg.content })),
    ];

    for (let step = 0; step < maxSteps; step++) {
      const completion = await client.chat.completions.create({
        model: modelName,
        messages: conversation,
        tools,
        temperature: 0.2,
      });

      const choice = completion.choices[0];
      if (!choice) {
        throw new Error("模型未返回有效的回复选项。");
      }

      const assistantMsg = choice.message;
      conversation.push(assistantMsg);

      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        const text = assistantMsg.content?.trim();
        if (!text) {
          throw new Error("模型返回了空回复。");
        }
        return text;
      }

      const toolResults = await Promise.all(
        toolCalls.map(async (call) => {
          if (call.type !== "function") {
            return {
              role: "tool" as const,
              tool_call_id: call.id,
              content: JSON.stringify({ error: `不支持的工具调用类型：${call.type}` }),
            };
          }

          const name = call.function.name as ToolName;
          const tool = toolRegistry[name];
          if (!tool) {
            return {
              role: "tool" as const,
              tool_call_id: call.id,
              content: JSON.stringify({ error: `未知工具：${call.function.name}` }),
            };
          }

          let rawArgs: unknown;
          try {
            rawArgs = JSON.parse(call.function.arguments || "{}");
          } catch {
            return {
              role: "tool" as const,
              tool_call_id: call.id,
              content: JSON.stringify({ error: "工具参数不是合法的 JSON，请修正后重试。" }),
            };
          }

          const parsed = tool.schema.safeParse(rawArgs);
          if (!parsed.success) {
            return {
              role: "tool" as const,
              tool_call_id: call.id,
              content: JSON.stringify({
                error: "工具参数校验失败，请按字段要求修正后重试。",
                issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                })),
              }),
            };
          }

          const result = (tool.run as (input: unknown) => unknown)(parsed.data);
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify(result),
          };
        }),
      );

      conversation.push(...toolResults);
    }

    throw new Error("对话处理步数超出上限，请简化指令后重试。");
  };
}

export const reply = createAgent({
  tasks: createJsonTaskStore(join("data", "tasks.json")),
});
