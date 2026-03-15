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
const GOOSE_CWD = process.env.GOOSE_CWD || "/home";

function resolveGooseCmd() {
  let cmd = GOOSE_CMD;
  try {
    const stat = fs.statSync(cmd);
    if (stat.isDirectory()) {
      const preferred = ["goose", "goose-cli"];
      for (const name of preferred) {
        const candidate = path.join(cmd, name);
        if (fs.existsSync(candidate)) {
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
          cmd = candidate;
          return cmd;
        } catch {
          // keep searching
        }
      }
    }
  } catch {
    // ignore, spawn will surface the error
  }
  return cmd;
}

function setupSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
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
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/run", (req, res) => {
  const instructions = req.body?.instructions;
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions is required" });
  }

  setupSse(res);

  const cmd = resolveGooseCmd();
  try {
    fs.accessSync(cmd, fs.constants.X_OK);
  } catch (err) {
    writeSse(res, "error", `Goose not executable at ${cmd}: ${err.message}`);
    return res.end();
  }

  const child = spawn(cmd, ["run", "--instructions", instructions], {
    cwd: GOOSE_CWD,
    env: process.env,
  });

  writeSse(res, "start", "started");

  child.stdout.on("data", (chunk) => {
    writeSse(res, "stdout", chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    writeSse(res, "stderr", chunk.toString());
  });

  child.on("close", (code) => {
    writeSse(res, "end", `exit ${code}`);
    res.end();
  });

  child.on("error", (err) => {
    writeSse(res, "error", err.message);
    res.end();
  });

  req.on("close", () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
