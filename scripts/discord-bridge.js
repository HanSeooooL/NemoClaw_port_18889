#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord → NemoClaw bridge.
 *
 * DMs and @mentions are forwarded to the OpenClaw agent running
 * inside the sandbox. Requires Message Content Intent enabled in
 * the Discord Developer Portal.
 *
 * Env:
 *   DISCORD_BOT_TOKEN     — from Discord Developer Portal
 *   NVIDIA_API_KEY        — for inference
 *   SANDBOX_NAME          — sandbox name (default: nemoclaw)
 *   ALLOWED_CHANNEL_IDS   — comma-separated channel IDs to accept (optional, accepts all if unset)
 */

const https = require("https");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNEL_IDS
  ? process.env.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim())
  : null;

if (!TOKEN) { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

// Gateway intents: GUILDS(1) | GUILD_MESSAGES(512) | MESSAGE_CONTENT(32768) | DIRECT_MESSAGES(4096)
const INTENTS = 1 | 512 | 32768 | 4096;

// ── Discord REST helpers ──────────────────────────────────────────

function discordApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "discord.com",
        path: `/api/v10${path}`,
        method,
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ error: buf }); }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sendMessage(channelId, content) {
  // Discord max message length is 2000
  const chunks = [];
  for (let i = 0; i < content.length; i += 1900) {
    chunks.push(content.slice(i, i + 1900));
  }
  for (const chunk of chunks) {
    await discordApi("POST", `/channels/${channelId}/messages`, { content: chunk })
      .catch((err) => console.error("sendMessage error:", err.message));
  }
}

async function sendTyping(channelId) {
  await discordApi("POST", `/channels/${channelId}/typing`, {}).catch(() => {});
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-dc-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("dc-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("[gateway]") &&
          !l.startsWith("[SECURITY") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();
      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// ── Discord Gateway (WebSocket) ───────────────────────────────────

let heartbeatTimer = null;
let sequence = null;
let botUser = null;

function startHeartbeat(ws, interval) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 1, d: sequence }));
    }
  }, interval);
}

async function connectGateway() {
  const gatewayInfo = await discordApi("GET", "/gateway/bot", null);
  const gatewayUrl = (gatewayInfo.url || "wss://gateway.discord.gg") + "/?v=10&encoding=json";

  const ws = new WebSocket(gatewayUrl);

  ws.addEventListener("message", async ({ data: raw }) => {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }

    if (payload.s !== null && payload.s !== undefined) sequence = payload.s;

    switch (payload.op) {
      case 10: // Hello
        startHeartbeat(ws, payload.d.heartbeat_interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: TOKEN,
            intents: INTENTS,
            properties: { os: "linux", browser: "nemoclaw", device: "nemoclaw" },
          },
        }));
        break;

      case 0: // Dispatch
        if (payload.t === "READY") {
          botUser = payload.d.user;
          console.log(`[gateway] connected as ${botUser.username}`);
        }

        if (payload.t === "MESSAGE_CREATE") {
          const msg = payload.d;

          // Ignore own messages and other bots
          if (botUser && msg.author.id === botUser.id) break;
          if (msg.author.bot) break;

          const channelId = msg.channel_id;

          if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(channelId)) {
            console.log(`[ignored] channel ${channelId} not in allowed list`);
            break;
          }

          // Respond to DMs or server messages where bot is @mentioned
          const isDM = msg.guild_id == null;
          const mentioned = botUser && (msg.mentions || []).some((u) => u.id === botUser.id);
          if (!isDM && !mentioned) break;

          // Strip @mentions from message text
          const text = msg.content.replace(/<@!?\d+>/g, "").trim();
          if (!text) break;

          const userName = msg.author.username;
          console.log(`[${channelId}] ${userName}: ${text}`);

          await sendTyping(channelId);
          const typingInterval = setInterval(() => sendTyping(channelId), 8000);

          try {
            const response = await runAgentInSandbox(text, channelId);
            clearInterval(typingInterval);
            console.log(`[${channelId}] agent: ${response.slice(0, 100)}...`);
            await sendMessage(channelId, response);
          } catch (err) {
            clearInterval(typingInterval);
            await sendMessage(channelId, `Error: ${err.message}`);
          }
        }
        break;

      case 11: // Heartbeat ACK
        break;
    }
  });

  ws.addEventListener("close", ({ code }) => {
    console.log(`[gateway] disconnected (code ${code}), reconnecting in 5s...`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(connectGateway, 5000);
  });

  ws.addEventListener("error", (event) => {
    const msg = /** @type {any} */ (event).message;
    console.error("[gateway] WebSocket error:", msg || event.type);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await discordApi("GET", "/users/@me", null);
  if (me.code) {
    console.error("Failed to connect to Discord:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Discord Bridge                            │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      ${(me.username + "                              ").slice(0, 40)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log("  │  DMs and @mentions are forwarded to OpenClaw       │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  await connectGateway();
}

main();
