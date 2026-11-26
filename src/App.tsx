import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task, UpdateTaskInput } from "../shared/task.ts";
import { requestReply } from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { fetchTasks, patchTask, removeTask } from "./task-client.ts";
import { TaskBoard } from "./TaskBoard.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [boardError, setBoardError] = useState("");
  const [boardOpen, setBoardOpen] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);

  async function syncTasks() {
    try {
      const latest = await fetchTasks();
      setTasks(latest);
      setBoardError("");
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : "加载清单失败。");
    } finally {
      setTasksLoading(false);
    }
  }

  useEffect(() => {
    void syncTasks();
  }, []);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(outgoing);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
      await syncTasks();
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  async function handleUpdateTask(id: string, changes: UpdateTaskInput) {
    try {
      const updated = await patchTask(id, changes);
      setTasks((prev) => prev.map((item) => (item.id === id ? updated : item)));
      setBoardError("");
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : "更新失败。");
    }
  }

  async function handleDeleteTask(id: string) {
    try {
      await removeTask(id);
      setTasks((prev) => prev.filter((item) => item.id !== id));
      setBoardError("");
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : "删除失败。");
    }
  }

  const pendingCount = tasks.filter((item) => !item.done).length;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src="/logo.png" alt="" />
          <strong>TokeNow</strong>
          <span>小明智能体</span>
        </div>
        <button
          type="button"
          className="board-toggle"
          aria-pressed={boardOpen}
          onClick={() => setBoardOpen((open) => !open)}
        >
          {boardOpen ? "收起清单" : `查看清单 (${pendingCount})`}
        </button>
      </header>
      <main className={`workspace${boardOpen ? "" : " board-hidden"}`}>
        <section className="chat-pane">
          <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="输入消息…"
                rows={2}
                value={draft}
                readOnly={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行</small>
          </div>
        </section>
        {boardOpen && (
          <TaskBoard
            tasks={tasks}
            loading={tasksLoading}
            error={boardError}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
            onQuickPrompt={(prompt) => void send(prompt)}
          />
        )}
      </main>
    </div>
  );
}
