const path = require("path");
const botStore = require("./botStore");
const { queueIncomingMessage } = require("./messageHandler");
const { transcribeAudio } = require("./speechToText");

const silentLogger = {
  level: "warn",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn("[baileys warn]", ...args),
  error: (...args) => console.error("[baileys error]", ...args),
  fatal: (...args) => console.error("[baileys fatal]", ...args),
  child: () => silentLogger,
};

// كل بوت إله اتصاله الخاص (socket)، جلسته الخاصة، ورمز QR خاص فيه — معزولين تماماً عن بعض
const connections = new Map(); // botId -> { sock, qr, status }

function authFolder(botId) {
  return path.join(__dirname, "..", "data", "bots", botId, "wa-auth");
}

async function startBotConnection(botId) {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
  } = require("@whiskeysockets/baileys");

  const { state, saveCreds } = await useMultiFileAuthState(authFolder(botId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  connections.set(botId, { sock, qr: null, status: "connecting" });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const conn = connections.get(botId);
    if (!conn) return;
    const { connection, lastDisconnect, qr } = update;

    console.log(`[wa:${botId}] connection.update:`, connection || "(qr/other)", qr ? "— QR received" : "");
    if (connection === "close") {
      console.log(
        `[wa:${botId}] disconnect reason:`,
        lastDisconnect?.error?.output?.statusCode,
        lastDisconnect?.error?.message
      );
    }

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
      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";
      let image = null;

      try {
        if (msg.message.imageMessage) {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          image = { base64: buffer.toString("base64"), mediaType: msg.message.imageMessage.mimetype || "image/jpeg" };
        } else if (msg.message.audioMessage) {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          const transcribed = await transcribeAudio(buffer, "voice.ogg");
          if (transcribed) {
            text = text ? `${text}\n${transcribed}` : transcribed;
          } else {
            await sendText(botId, from, "سمعت إنك بعتلي رسالة صوتية، بس ما قدرت أسمعها منيح 🙏 ممكن تكتبلي طلبك؟");
            continue;
          }
        }

        if (!text && !image) continue;

        queueIncomingMessage(
          botId,
          from,
          text,
          image,
          (to, t) => sendText(botId, to, t),
          undefined,
          (to, imageUrl) => sendImage(botId, to, imageUrl)
        );
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
