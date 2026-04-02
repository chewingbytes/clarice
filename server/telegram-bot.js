require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { Bot } = require("grammy");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = process.env.API_BASE || "http://127.0.0.1:3000";

if (!TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

const bot = new Bot(TOKEN);
const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_PATH = path.join(DATA_DIR, "telegram-sessions.json");

const loadStore = () => {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { threads: {} };
  }
};

const saveStore = (store) => {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
};

const getThreadKey = (chatId, threadId) => `${chatId}:${threadId}`;

const fetchSessions = async (limit = 20, query = "") => {
  const url = new URL(`${API_BASE}/sessions`);
  url.searchParams.set("limit", String(limit));
  if (query) url.searchParams.set("q", query);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`sessions failed: ${res.status}`);
  const data = await res.json();
  return data.sessions || [];
};

const fetchLatestSession = async () => {
  const res = await fetch(`${API_BASE}/sessions/latest`);
  if (!res.ok) throw new Error(`latest failed: ${res.status}`);
  const data = await res.json();
  return data.session || null;
};

const fetchSessionById = async (sessionId) => {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.session || null;
};

const withTyping = async (ctx, fn) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (!chatId) return fn();

  const sendTyping = async () => {
    try {
      await ctx.api.sendChatAction(chatId, "typing", {
        message_thread_id: threadId,
      });
    } catch {
      // ignore typing errors
    }
  };

  await sendTyping();
  const interval = setInterval(sendTyping, 3500);

  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
};

const runGoose = async ({ instructions, sessionId }) => {
  const res = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions, sessionId }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const output = { stdout: [], stderr: [], sessionId: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = "message";
      let data = "";

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5) + "\n";
      }

      data = data.trimEnd();
      if (!data) continue;

      if (event === "stdout") output.stdout.push(data);
      if (event === "stderr" || event === "error") output.stderr.push(data);
      if (event === "session") output.sessionId = data.trim();
    }
  }

  return output;
};

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Hey I'm Clarice!\n\nUse /newtopic <prompt> to create a new session topic or send a message inside a session topic to resume it.",
  );
});

bot.command("sessions", async (ctx) => {
  try {
    const text = ctx.message?.text || "";
    const args = text.split(" ").slice(1);
    const limit = Number.parseInt(args[0], 10) || 10;
    const sessions = await fetchSessions(limit);
    if (!sessions.length) {
      return ctx.reply("No sessions found.");
    }
    const list = sessions.map((s) => `• ${s.name} (${s.id})`).join("\n");
    return ctx.reply(`Recent sessions:\n${list}`);
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

bot.command("latest", async (ctx) => {
  try {
    const session = await fetchLatestSession();
    if (!session) return ctx.reply("No sessions found.");
    return ctx.reply(`Latest session: ${session.name} (${session.id})`);
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

bot.command("session", async (ctx) => {
  if (!ctx.chat?.is_forum) {
    return ctx.reply("This command only works in forum-enabled supergroups.");
  }
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const store = loadStore();
  const key = getThreadKey(ctx.chat.id, threadId);
  const sessionId = store.threads[key];

  if (!sessionId) return ctx.reply("This topic is not linked to a session.");
  return ctx.reply(`Linked session: ${sessionId}`);
});

bot.command("link", async (ctx) => {
  if (!ctx.chat?.is_forum) {
    return ctx.reply("This command only works in forum-enabled supergroups.");
  }
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const text = ctx.message?.text || "";
  const sessionId = text.replace(/^\/link\s*/i, "").trim();
  if (!sessionId) return ctx.reply("Usage: /link <sessionId>");

  try {
    const session = await fetchSessionById(sessionId);
    if (!session) return ctx.reply("Session not found.");

    const store = loadStore();
    store.threads[getThreadKey(ctx.chat.id, threadId)] = sessionId;
    saveStore(store);

    await ctx.api.editForumTopic(ctx.chat.id, threadId, { name: session.name });
    return ctx.reply(`Linked to session ${session.name} (${session.id}).`);
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

bot.command("unlink", async (ctx) => {
  if (!ctx.chat?.is_forum) {
    return ctx.reply("This command only works in forum-enabled supergroups.");
  }
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const store = loadStore();
  const key = getThreadKey(ctx.chat.id, threadId);
  delete store.threads[key];
  saveStore(store);

  return ctx.reply("Session unlinked from this topic.");
});

bot.command("rename", async (ctx) => {
  if (!ctx.chat?.is_forum) {
    return ctx.reply("This command only works in forum-enabled supergroups.");
  }
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const text = ctx.message?.text || "";
  const name = text.replace(/^\/rename\s*/i, "").trim();
  if (!name) return ctx.reply("Usage: /rename <topic name>");

  try {
    await ctx.api.editForumTopic(ctx.chat.id, threadId, { name });
    return ctx.reply("Topic renamed.");
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

bot.command("newtopic", async (ctx) => {
  const text = ctx.message?.text || "";
  const prompt = text.replace(/^\/newtopic\s*/i, "").trim();

  if (!ctx.chat?.is_forum) {
    return ctx.reply("This command only works in forum-enabled supergroups.");
  }

  if (!prompt) {
    return ctx.reply("Usage: /newtopic <your prompt>");
  }

  try {
    const topic = await ctx.api.createForumTopic(ctx.chat.id, "New session");
    const threadId = topic.message_thread_id;
    await ctx.api.sendMessage(ctx.chat.id, "Creating session...", {
      message_thread_id: threadId,
    });

    await withTyping(ctx, async () => {
      const output = await runGoose({ instructions: prompt, sessionId: null });
      const sessions = await fetchSessions();
      const latest = sessions[0];

      if (latest?.name) {
        await ctx.api.editForumTopic(ctx.chat.id, threadId, { name: latest.name });
      }

      const store = loadStore();
      store.threads[getThreadKey(ctx.chat.id, threadId)] = latest?.id || null;
      saveStore(store);

      const replyText = output.stdout.join("\n\n") || "(no output)";
      await ctx.api.sendMessage(ctx.chat.id, replyText.slice(0, 3500), {
        message_thread_id: threadId,
      });

      if (output.stderr.length) {
        await ctx.api.sendMessage(ctx.chat.id, output.stderr.join("\n\n").slice(0, 3500), {
          message_thread_id: threadId,
        });
      }
    });
  } catch (err) {
    return ctx.reply(`Error: ${err.message}`);
  }
});

bot.on("message:text", async (ctx) => {
  if (!ctx.chat?.is_forum) return;
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;

  const store = loadStore();
  const key = getThreadKey(ctx.chat.id, threadId);
  const sessionId = store.threads[key];

  if (!sessionId) {
    return ctx.reply("This topic is not linked to a session. Use /newtopic <prompt> to create one.");
  }

  try {
    await withTyping(ctx, async () => {
      const output = await runGoose({ instructions: ctx.message.text, sessionId });
      const replyText = output.stdout.join("\n\n") || "(no output)";

      await ctx.api.sendMessage(ctx.chat.id, replyText.slice(0, 3500), {
        message_thread_id: threadId,
      });

      if (output.stderr.length) {
        await ctx.api.sendMessage(ctx.chat.id, output.stderr.join("\n\n").slice(0, 3500), {
          message_thread_id: threadId,
        });
      }
    });
  } catch (err) {
    await ctx.api.sendMessage(ctx.chat.id, `Error: ${err.message}`, {
      message_thread_id: threadId,
    });
  }
});

bot.start();
