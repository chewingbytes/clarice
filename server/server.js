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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/run", (req, res) => {
  const instructions = req.body?.instructions;
  console.log("[POST /run] Received instructions:", instructions);
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

  const child = spawn(cmd, ["run", "--instructions", instructions], {
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

  child.on("close", (code, signal) => {
    console.log(`[child.close] Goose process exited with code: ${code}, signal: ${signal}`);
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
