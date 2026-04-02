const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const GOOSE_CMD = process.env.GOOSE_CMD || "goose";
const GOOSE_CWD = process.env.GOOSE_CWD || process.cwd();

function resolveGooseCmd() {
  let cmd = GOOSE_CMD;
  console.log("[resolveGooseCmd] Initial GOOSE_CMD:", cmd);
  try {
    const stat = fs.statSync(cmd);
    if (stat.isDirectory()) {
      const preferred = ["goose", "goose-cli"];
      for (const name of preferred) {
        const candidate = path.join(cmd, name);
        if (fs.existsSync(candidate)) {
          console.log(`[resolveGooseCmd] Found preferred binary: ${candidate}`);
          cmd = candidate;
          return cmd;
        }
      }

      const entries = fs.readdirSync(cmd, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const candidate = path.join(cmd, entry.name);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          console.log(`[resolveGooseCmd] Found executable file: ${candidate}`);
          cmd = candidate;
          return cmd;
        } catch {
          // keep searching
        }
      }
    }
  } catch {
    // ignore, spawn will surface the error
    console.log(`[resolveGooseCmd] Error resolving Goose command at path: ${cmd}`);
  }
  return cmd;
}

function setupSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  console.log("[setupSse] SSE headers set.");
}

function writeSse(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const lines = String(data).split(/\r?\n/);
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
  console.log(`[writeSse] Sent event: ${event}, data:`, data);
}

function listGooseSessions(limit = 20) {
  return new Promise((resolve, reject) => {
    const args = ["session", "list", "-l", String(limit)];
    const child = spawn(resolveGooseCmd(), args, {
      cwd: GOOSE_CWD,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `goose session list exited ${code}`));
      }
      const sessions = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.toLowerCase().startsWith("available sessions")) continue;
        const match = trimmed.match(/^([0-9]{8}_[0-9]+)\s+-\s+(.+?)\s+-\s+(.+)$/);
        if (match) {
          sessions.push({
            id: match[1],
            name: match[2],
            createdAt: match[3],
          });
        }
      }
      resolve(sessions);
    });

    child.on("error", (err) => reject(err));
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/sessions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const q = String(req.query.q || "").trim().toLowerCase();
    const sessions = await listGooseSessions(limit);
    const filtered = q
      ? sessions.filter(
          (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        )
      : sessions;
    res.json({ sessions: filtered });
  } catch (err) {
    console.log("[GET /sessions] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/latest", async (_req, res) => {
  try {
    const sessions = await listGooseSessions(1);
    res.json({ session: sessions[0] || null });
  } catch (err) {
    console.log("[GET /sessions/latest] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/:id", async (req, res) => {
  try {
    const sessionId = String(req.params.id);
    const sessions = await listGooseSessions(200);
    const session = sessions.find((s) => s.id === sessionId) || null;
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ session });
  } catch (err) {
    console.log("[GET /sessions/:id] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/run", (req, res) => {
  const instructions = req.body?.instructions;
  const sessionId = req.body?.sessionId;
  console.log("[POST /run] Received instructions:", instructions);
  if (sessionId) {
    console.log("[POST /run] Using sessionId:", sessionId);
  }
  if (!instructions || typeof instructions !== "string") {
    console.log("[POST /run] Invalid instructions received.");
    return res.status(400).json({ error: "instructions is required" });
  }

  setupSse(res);

  const cmd = resolveGooseCmd();
  console.log(`[POST /run] Using Goose command: ${cmd}`);
  try {
    if (path.isAbsolute(cmd) || fs.existsSync(cmd)) {
      fs.accessSync(cmd, fs.constants.X_OK);
      console.log(`[POST /run] Goose command is executable.`);
    } else {
      console.log("[POST /run] Goose command appears to be on PATH.");
    }
  } catch (err) {
    console.log(`[POST /run] Goose not executable: ${err.message}`);
    writeSse(res, "error", `Goose not executable at ${cmd}: ${err.message}`);
    return res.end();
  }

  const args = ["run", "--text", instructions];
  if (sessionId && typeof sessionId === "string") {
    args.push("--resume", "--session-id", sessionId);
  }

  const child = spawn(cmd, args, {
    cwd: GOOSE_CWD,
    env: process.env,
  });
  console.log(`[POST /run] Spawned Goose process with PID: ${child.pid}`);

  writeSse(res, "start", "started");

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    console.log(`[child.stdout]`, chunk.toString());
    writeSse(res, "stdout", chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    console.log(`[child.stderr]`, chunk.toString());
    writeSse(res, "stderr", chunk.toString());
  });

  child.on("close", async (code, signal) => {
    console.log(`[child.close] Goose process exited with code: ${code}, signal: ${signal}`);
    if (!sessionId) {
      try {
        const sessions = await listGooseSessions(1);
        if (sessions[0]?.id) {
          writeSse(res, "session", sessions[0].id);
        }
      } catch (err) {
        console.log("[child.close] Failed to fetch latest session:", err.message);
      }
    }

    if (signal) {
      writeSse(res, "end", `signal ${signal}`);
    } else {
      writeSse(res, "end", `exit ${code}`);
    }
    res.end();
  });

  child.on("error", (err) => {
    console.log(`[child.error]`, err);
    writeSse(res, "error", err.message);
    res.end();
  });

  res.on("close", () => {
    console.log("[res.close] Client disconnected, killing Goose process if still running.");
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
  req.on("aborted", () => {
    console.log("[req.aborted] Request aborted, killing Goose process if still running.");
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
});

app.listen(PORT, () => {
  console.log(`[app.listen] Server listening on ${PORT}`);
});
