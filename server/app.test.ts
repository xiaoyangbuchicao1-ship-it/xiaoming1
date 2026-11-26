import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/task.ts";
import { createAgent, type ModelClient } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

type MockCompletionStep = (
  messages: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming["messages"],
) => OpenAI.Chat.Completions.ChatCompletionMessage;

function createMockModelClient(steps: MockCompletionStep[]): ModelClient {
  let cursor = 0;
  return {
    chat: {
      completions: {
        async create(params) {
          const handler = steps[cursor++];
          if (!handler) throw new Error(`Mock 模型步骤不足，第 ${cursor} 次调用未定义。`);
          const message = handler(params.messages);
          return {
            id: `mock-${cursor}`,
            object: "chat.completion",
            created: 0,
            model: params.model,
            choices: [
              {
                index: 0,
                logprobs: null,
                message,
                finish_reason: message.tool_calls ? "tool_calls" : "stop",
              },
            ],
          };
        },
      },
    },
  };
}

function toolCallMsg(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): OpenAI.Chat.Completions.ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

function textMsg(content: string): OpenAI.Chat.Completions.ChatCompletionMessage {
  return { role: "assistant", content, refusal: null };
}

function parseLastToolPayload(
  messages: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming["messages"],
): unknown {
  const lastTool = [...messages].reverse().find((m) => m.role === "tool");
  assert.ok(lastTool && typeof lastTool.content === "string");
  return JSON.parse(lastTool.content);
}

async function startTestApp(
  t: TestContext,
  customReply?: (messages: ChatMessage[], filename: string) => Promise<string>,
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const tasks = createJsonTaskStore(filename);
  const app = createApp({
    tasks,
    async reply(messages) {
      conversations.push(messages);
      return customReply ? customReply(messages, filename) : "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("黄金测试 1：官方 6 步基础全流程 + 刷新重启后不丢账", async (t) => {
  const mockClient = createMockModelClient([
    () => toolCallMsg([{ id: "c1", name: "create_task", args: { title: "买牛奶" } }]),
    () => textMsg("已帮你记下「买牛奶」。"),
    () => toolCallMsg([{ id: "c2", name: "create_task", args: { title: "取快递" } }]),
    () => textMsg("已添加「取快递」。"),
    () => toolCallMsg([{ id: "c3", name: "list_tasks", args: {} }]),
    (msgs) => {
      const payload = parseLastToolPayload(msgs) as { tasks: Task[] };
      return textMsg(
        payload.tasks.map((item) => `${item.title}(${item.done ? "已完成" : "待办"})`).join("、"),
      );
    },
    () => toolCallMsg([{ id: "c4", name: "list_tasks", args: {} }]),
    (msgs) => {
      const payload = parseLastToolPayload(msgs) as { tasks: Task[] };
      const milk = payload.tasks.find((item) => item.title === "买牛奶")!;
      return toolCallMsg([{ id: "c5", name: "update_task", args: { id: milk.id, done: true } }]);
    },
    () => textMsg("「买牛奶」已标记为已完成，「取快递」仍为待办。"),
    () => toolCallMsg([{ id: "c6", name: "list_tasks", args: {} }]),
    (msgs) => {
      const payload = parseLastToolPayload(msgs) as { tasks: Task[] };
      const parcel = payload.tasks.find((item) => item.title === "取快递")!;
      return toolCallMsg([{ id: "c7", name: "delete_task", args: { id: parcel.id } }]);
    },
    () => textMsg("已删除「取快递」。"),
    () => toolCallMsg([{ id: "c8", name: "list_tasks", args: {} }]),
    (msgs) => {
      const payload = parseLastToolPayload(msgs) as { tasks: Task[] };
      return textMsg(
        `当前任务：${payload.tasks.map((item) => `${item.title}-${item.done}`).join(",")}`,
      );
    },
  ]);

  const { request, filename } = await startTestApp(t, (messages, file) => {
    const agent = createAgent({ tasks: createJsonTaskStore(file), getClient: () => mockClient });
    return agent(messages);
  });

  const history: ChatMessage[] = [];
  async function say(content: string) {
    history.push({ role: "user", content });
    const res = await request("POST", "/api/chat", { messages: history });
    assert.equal(res.status, 200);
    const replyText = (res.body as { reply: string }).reply;
    history.push({ role: "assistant", content: replyText });
    return replyText;
  }

  await say("帮我记一下买牛奶");
  await say("再记一条取快递");
  const list1 = await say("我有哪些任务？");
  assert.match(list1, /买牛奶\(待办\).*取快递\(待办\)/);

  await say("牛奶买好了");
  await say("取快递这条删掉吧");
  const list2 = await say("再给我看看清单");
  assert.equal(list2, "当前任务：买牛奶-true");

  // 模拟服务重启 + 浏览器刷新清空对话历史，依然能从磁盘读回真实任务
  const restartedClient = createMockModelClient([
    () => toolCallMsg([{ id: "r1", name: "list_tasks", args: {} }]),
    (msgs) => {
      const payload = parseLastToolPayload(msgs) as { tasks: Task[] };
      return textMsg(
        `重启后读取：${payload.tasks.map((item) => `${item.title}:${item.done}`).join(",")}`,
      );
    },
  ]);
  const restartedAgent = createAgent({
    tasks: createJsonTaskStore(filename),
    getClient: () => restartedClient,
  });
  const afterRestart = await restartedAgent([{ role: "user", content: "现在还剩什么任务？" }]);
  assert.equal(afterRestart, "重启后读取：买牛奶:true");
});

test("黄金测试 2：撞名任务不乱点、不存在的任务不瞎编", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-ambiguity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(directory, "tasks.json"));
  const pureMilk = store.create("买纯牛奶");
  const yogurt = store.create("买酸奶");

  const mockClient = createMockModelClient([
    // 撞名时先 list_tasks，然后直接反问确认（不调用 update_task）
    () => toolCallMsg([{ id: "a1", name: "list_tasks", args: {} }]),
    () => textMsg("请问你指的是「买纯牛奶」还是「买酸奶」？"),
    // 不存在的任务先 list_tasks，然后如实回复未找到（不调用 delete_task）
    () => toolCallMsg([{ id: "a2", name: "list_tasks", args: {} }]),
    () => textMsg("清单里没有找到「交水电费」这条任务。"),
    // 模型误传错误 ID 时工具返回错误，模型可自纠而不是崩溃
    () => toolCallMsg([{ id: "a3", name: "delete_task", args: { id: "non-existent" } }]),
    (msgs) => {
      const err = parseLastToolPayload(msgs) as { error: string };
      assert.match(err.error, /找不到/);
      return textMsg("任务不存在，未能删除。");
    },
  ]);

  const reply = createAgent({ tasks: store, getClient: () => mockClient });
  const r1 = await reply([{ role: "user", content: "牛奶买好了" }]);
  assert.match(r1, /买纯牛奶.*买酸奶/);
  assert.deepEqual(store.list(), [pureMilk, yogurt]);

  const r2 = await reply([{ role: "user", content: "帮我把交水电费划掉" }]);
  assert.match(r2, /没有找到/);
  assert.deepEqual(store.list(), [pureMilk, yogurt]);

  const r3 = await reply([{ role: "user", content: "删掉未知任务" }]);
  assert.match(r3, /不存在/);
});

test("黄金测试 3：一句话多意图 + 实时时间感知与逾期/今日筛选", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-time-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(directory, "tasks.json"));
  store.create({ title: "昨日遗留对账", dueDate: "2026-11-24" });

  let capturedDueToday: unknown;
  const mockClient = createMockModelClient([
    // 单轮同时发出两个 create_task
    () =>
      toolCallMsg([
        {
          id: "m1",
          name: "create_task",
          args: { title: "完成周报", dueDate: "2026-11-25", priority: "high" },
        },
        { id: "m2", name: "create_task", args: { title: "寄顺丰快递", dueDate: "2026-11-26" } },
      ]),
    () => textMsg("已记下两条任务。"),
    () => toolCallMsg([{ id: "m3", name: "list_tasks", args: { filter: "due_today" } }]),
    (msgs) => {
      capturedDueToday = parseLastToolPayload(msgs);
      return textMsg("今天到期：完成周报；另有 1 项已逾期：昨日遗留对账。");
    },
  ]);

  const fixedNow = () => new Date(2026, 10, 25, 10, 0, 0);
  const reply = createAgent({ tasks: store, getClient: () => mockClient, now: fixedNow });

  await reply([
    { role: "user", content: "记两件事：今天前完成周报（高优先级），明天记得寄顺丰快递" },
  ]);
  const all = store.list();
  assert.equal(all.length, 3);
  assert.equal(all[1]?.dueDate, "2026-11-25");
  assert.equal(all[1]?.priority, "high");
  assert.equal(all[2]?.dueDate, "2026-11-26");

  const dueAnswer = await reply([{ role: "user", content: "今天有哪些任务到期？" }]);
  assert.match(dueAnswer, /完成周报/);
  assert.deepEqual(
    (capturedDueToday as { today: string; summary: Record<string, number>; tasks: Task[] }).today,
    "2026-11-25",
  );
  assert.deepEqual((capturedDueToday as { summary: Record<string, number> }).summary, {
    total: 3,
    pending: 3,
    done: 0,
    dueToday: 1,
    overdue: 1,
  });
  assert.equal(
    (capturedDueToday as { tasks: Task[] }).tasks.map((item) => item.title).join(","),
    "完成周报",
  );
});

test("黄金测试 4：子任务/工作量扩展与历史自定义字段零破坏", async (t) => {
  const { request, filename } = await startTestApp(t);
  const legacy = {
    id: "legacy-1",
    title: "买牛奶",
    done: false,
    priority: 1,
    customTag: "keep-me",
  };
  await writeFile(filename, JSON.stringify([legacy]));

  const created = await request("POST", "/api/tasks", {
    title: "准备面试",
    priority: "high",
    effort: "large",
    dueDate: "2026-11-28",
    subtasks: [{ title: "看代码" }, { title: "写测试" }],
  });
  assert.equal(created.status, 201);
  const parent = created.body as Task;
  assert.equal(parent.subtasks?.length, 2);

  // 全部子任务完成后，不擅自把父任务改成 done: true（方案 2A）
  const updatedSubtasks = parent.subtasks!.map((sub) => ({ ...sub, done: true }));
  const patched = await request("PATCH", `/api/tasks/${parent.id}`, { subtasks: updatedSubtasks });
  assert.equal(patched.status, 200);
  const updatedParent = patched.body as Task;
  assert.equal(updatedParent.done, false);
  assert.equal(
    updatedParent.subtasks?.every((sub) => sub.done),
    true,
  );

  // 历史任务扩展字段完全保留
  assert.equal(createJsonTaskStore(filename).list()[0]?.customTag, "keep-me");
  assert.equal(createJsonTaskStore(filename).list()[0]?.priority, 1);

  // 删除父任务时子任务一同清理，不留孤儿数据
  assert.equal((await request("DELETE", `/api/tasks/${parent.id}`)).status, 204);
  assert.deepEqual(createJsonTaskStore(filename).list(), [legacy]);
});

test("黄金测试 5：Fail-Fast 边界保护、清除属性与无效字段拒绝", async (t) => {
  const { request } = await startTestApp(t, async (messages, file) => {
    const agent = createAgent({
      tasks: createJsonTaskStore(file),
      getClient: () => {
        throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
      },
    });
    return agent(messages);
  });

  // 缺失 Key 时不静默吞错，显式暴露配置提示
  const missingKeyRes = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "你好" }],
  });
  assert.equal(missingKeyRes.status, 500);
  assert.match((missingKeyRes.body as { error: string }).error, /DEEPSEEK_API_KEY/);

  // 拒绝非法日历日期和枚举值
  assert.equal(
    (await request("POST", "/api/tasks", { title: "测试", dueDate: "2026-02-30" })).status,
    400,
  );
  assert.equal(
    (await request("POST", "/api/tasks", { title: "测试", priority: "urgent" })).status,
    400,
  );
  assert.equal(
    (await request("POST", "/api/tasks", { title: "测试", effort: "huge" })).status,
    400,
  );

  // 支持通过 null 显式清除可选字段
  const created = await request("POST", "/api/tasks", {
    title: "整理桌面的线",
    dueDate: "2026-11-26",
    priority: "medium",
    effort: "small",
  });
  const task = created.body as Task;
  const cleared = await request("PATCH", `/api/tasks/${task.id}`, {
    dueDate: null,
    priority: null,
    effort: null,
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { id: task.id, title: "整理桌面的线", done: false });
});
