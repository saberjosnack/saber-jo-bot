const path = require("path");
const botStore = require("./botStore");
const { handleIncomingMessage } = require("./messageHandler");

const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

// كل بوت إله اتصاله الخاص (socket)، جلسته الخاصة، ورمز QR خاص فيه — معزولين تماماً عن بعض
const connections = new Map(); // botId -> { sock, qr, status }

function authFolder(botId) {
  return path.join(__dirname, "..", "data", "bots", botId, "wa-auth");
}

async function startBotConnection(botId) {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

  const { state, saveCreds } = await useMultiFileAuthState(authFolder(botId));

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
  });

  connections.set(botId, { sock, qr: null, status: "connecting" });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const conn = connections.get(botId);
    if (!conn) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      conn.qr = qr;
      conn.status = "waiting_for_scan";
    }

    if (connection === "open") {
      conn.status = "connected";
      conn.qr = null;
      botStore.updateBot(botId, { status: "active" });
      console.log(`بوت ${botId} متصل مباشرة بواتساب ✅`);
    }

    if (connection === "close") {
      conn.status = "disconnected";
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (!loggedOut) {
        startBotConnection(botId); // إعادة محاولة تلقائية
      } else {
        botStore.updateBot(botId, { status: "pending_connection" });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "");
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      try {
        await handleIncomingMessage(botId, from, text, null, (to, t) => sendText(botId, to, t));
      } catch (err) {
        console.error(`خطأ بمعالجة رسالة للبوت ${botId}:`, err);
      }
    }
  });

  return connections.get(botId);
}

async function startAllActiveBots() {
  const bots = botStore.listBots();
  for (const bot of bots) {
    if (bot.status === "active" || bot.status === "pending_connection") {
      startBotConnection(bot.id).catch((err) =>
        console.error(`فشل بدء اتصال البوت ${bot.name}:`, err)
      );
    }
  }
}

async function sendText(botId, to, text) {
  const conn = connections.get(botId);
  if (!conn?.sock) throw new Error("هاد البوت مش متصل بواتساب بعد.");
  await conn.sock.sendMessage(`${to}@s.whatsapp.net`, { text });
}

async function sendImage(botId, to, imageUrl, caption = "") {
  const conn = connections.get(botId);
  if (!conn?.sock) throw new Error("هاد البوت مش متصل بواتساب بعد.");
  await conn.sock.sendMessage(`${to}@s.whatsapp.net`, { image: { url: imageUrl }, caption });
}

function getQrStatus(botId) {
  const conn = connections.get(botId);
  if (!conn) return { status: "not_started", qr: null };
  return { status: conn.status, qr: conn.qr };
}

module.exports = { startBotConnection, startAllActiveBots, sendText, sendImage, getQrStatus };
