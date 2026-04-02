"use client";

import { useEffect, useMemo, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("Idle");
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);

  const apiBase = useMemo(
    () => process.env.NEXT_PUBLIC_API_BASE || "http://77.42.88.223:3000",
    [],
  );

  const addMessage = (text, role) => {
    setMessages((prev) => [...prev, { text, role }]);
  };

  const loadSessions = async () => {
    try {
      const res = await fetch(`${apiBase}/sessions`);
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const runGoose = async (instructions) => {
    setStatus("Running...");

    console.log("INSTRUCTIONS:", instructions);
    addMessage(instructions, "user");

    const res = await fetch(`${apiBase}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions, sessionId }),
    });

    console.log("RESPONSE:", res);

    if (!res.ok || !res.body) {
      setStatus("Error");
      addMessage(`Request failed: ${res.status}`, "stderr");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      console.log("RESPONSE OUTPUT:", buffer);

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        console.log("RESPONSE CHUNK:", chunk);

        let event = "message";
        let data = "";

        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5) + "\n";
        }

        data = data.trimEnd();
        if (!data) continue;

        if (event === "stdout") addMessage(data, "bot");
        else if (event === "stderr") addMessage(data, "stderr");
        else if (event === "session") {
          setSessionId(data.trim());
          loadSessions();
        } else if (event === "error") {
          addMessage(data, "stderr");
          setStatus("Error");
        } else if (event === "start") {
          setStatus("Running...");
        } else if (event === "end") {
          setStatus(`Finished (${data})`);
        }
      }
    }

    setStatus("Idle");
    loadSessions();
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const instructions = input.trim();
    if (!instructions) return;
    setInput("");
    runGoose(instructions).catch((err) => {
      setStatus("Error");
      addMessage(err.message, "stderr");
    });
  };

  const startNewSession = () => {
    setMessages([]);
    setStatus("Idle");
    setSessionId(null);
  };

  const statusTone = status.startsWith("Running")
    ? "running"
    : status.startsWith("Error")
      ? "error"
      : status.startsWith("Finished")
        ? "done"
        : "idle";

  return (
    <div className="app">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">G</div>
            <div>
              <div className="brand-title">Goose Studio</div>
              <div className="brand-subtitle">Streaming CLI sessions</div>
            </div>
          </div>

          <div className="session-summary">
            <div className="session-label">Current session</div>
            <div className="session-value">
              {sessionId || "New session (not yet created)"}
            </div>
            <div className="session-actions">
              <button type="button" className="secondary" onClick={loadSessions}>
                Refresh
              </button>
              <button type="button" className="secondary" onClick={startNewSession}>
                New Session
              </button>
            </div>
          </div>

          <div className="session-list">
            <div className="session-list-title">Recent sessions</div>
            {sessions.length === 0 ? (
              <div className="sessions-empty">No sessions found.</div>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`session-item ${s.id === sessionId ? "active" : ""}`}
                  onClick={() => setSessionId(s.id)}
                >
                  <div className="session-name">{s.name}</div>
                  <div className="session-meta">{s.id} • {s.createdAt}</div>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="chat">
          <div className="chat-header">
            <div>
              <div className="chat-title">Conversation</div>
              <div className="chat-subtitle">Live SSE stream from Goose</div>
            </div>
            <div className={`status-pill ${statusTone}`}>{status}</div>
          </div>

          <div className="messages">
            {messages.length === 0 ? (
              <div className="messages-empty">
                Send a prompt to start the session.
              </div>
            ) : (
              messages.map((m, idx) => (
                <div key={idx} className={`msg ${m.role}`}>
                  {m.text}
                </div>
              ))
            )}
          </div>

          <form className="composer" onSubmit={onSubmit}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send instructions to Goose..."
              required
            />
            <button type="submit">Send</button>
          </form>
        </main>
      </div>
    </div>
  );
}
