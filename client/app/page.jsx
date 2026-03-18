"use client";

import { useMemo, useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("Idle");

  const apiBase = useMemo(
    () => process.env.NEXT_PUBLIC_API_BASE || "http://77.42.88.223:3000",
    []
  );

  const addMessage = (text, role) => {
    setMessages((prev) => [...prev, { text, role }]);
  };

  const runGoose = async (instructions) => {
    setStatus("Running...");

    console.log("INSTRUCTIONS:", instructions);
    addMessage(instructions, "user");

    const res = await fetch(`${apiBase}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
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
          else if (event === "error") {
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

  return (
    <div className="app">
      <header>Goose CLI Chat</header>
      <div className="messages">
        {messages.map((m, idx) => (
          <div key={idx} className={`msg ${m.role}`}>{m.text}</div>
        ))}
      </div>
      <div className="status">{status}</div>
      <form onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send instructions to Goose..."
          required
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
