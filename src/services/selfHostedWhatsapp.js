const fs = require("fs");
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

// بيمسح جلسة الاتصال المحفوظة على القرص. لازم نعمل هاد لما واتساب يسجّل خروج الجلسة فعلياً (401) —
// وإلا أي محاولة اتصال جاية (تلقائية أو يدوية) بترجع تستخدم نفس الجلسة الملغاة وترفض فوراً بنفس الخطأ (401)
// بدون ما تعرض رمز QR جديد أبداً، فيضل البوت عالق "منقطع" للأبد حتى لو حاولنا نعيد المحاولة ألف مرة.
function clearAuthFolder(botId) {
  try {
    fs.rmSync(authFolder(botId), { recursive: true, force: true });
    console.log(`[wa:${botId}] مسحت جلسة الاتصال القديمة (كانت ملغاة) — أي محاولة اتصال جاية رح تطلع رمز QR جديد.`);
  } catch (err) {
    console.error(`[wa:${botId}] فشل مسح جلسة الاتصال القديمة:`, err.message);
  }
}

// بيعيد محاولة الاتصال بعد فترة انتظار (بتزيد تدريجياً لحد سقف دقيقة)، وبيكرر المحاولة تلقائياً لو فشلت
// المحاولة نفسها (مش بس لو انقطع اتصال ناجح) — عشان أي مشكلة شبكة عابرة ما توقف إعادة الاتصال للأبد.
const reconnectDelays = new Map(); // botId -> آخر مدة انتظار استخدمناها

function scheduleReconnect(botId) {
  const delay = reconnectDelays.get(botId) || 3000;
  console.log(`[wa:${botId}] رح أعيد محاولة الاتصال خلال ${Math.round(delay / 1000)} ثانية...`);
  setTimeout(() => {
    startBotConnection(botId)
      .then(() => reconnectDelays.delete(botId)) // نجحت — نرجع نصفّر مدة الانتظار لأي مرة جاية
      .catch((err) => {
        console.error(`[wa:${botId}] فشلت محاولة إعادة الاتصال:`, err.message);
        reconnectDelays.set(botId, Math.min(delay * 2, 60000));
        scheduleReconnect(botId);
      });
  }, delay);
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

  // لو فشل جلب آخر نسخة (مشكلة شبكة مؤقتة مثلاً)، ما بدنا هاد الفشل يوقف كل محاولة الاتصال —
  // منكمل بالنسخة الافتراضية المدمجة بمكتبة Baileys بدل ما تتعلق كل عملية إعادة الاتصال على هاد الطلب الخارجي.
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    console.warn(`[wa:${botId}] ما قدرت أجيب آخر نسخة Baileys، هستخدم النسخة الافتراضية:`, err.message);
  }

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
        // إعادة محاولة تلقائية — بـ .catch() صريح + إعادة جدولة، عشان لو فشلت المحاولة نفسها (مثلاً مشكلة شبكة
        // عابرة قبل ما يتفتح أي socket أصلاً) ما يضل الاتصال عالق "منقطع" للأبد بصمت بدون أي محاولة تانية.
        scheduleReconnect(botId);
      } else {
        // تسجيل خروج حقيقي (401) — منمسح الجلسة المحفوظة فوراً، وإلا كل محاولة جاية (تلقائية عالبووت
        // أو زر "إعادة تشغيل الاتصال" اليدوي) بترجع تستخدم نفس الجلسة الملغاة وتفشل بنفس الخطأ من غير ما يطلع QR جديد أبداً.
        clearAuthFolder(botId);
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
          (to, imageUrl) => sendImage(botId, to, imageUrl),
          "whatsapp"
        );
      } catch (err) {
        console.error(`خطأ بمعالجة رسالة للبوت ${botId}:`, err);
      }
    }
  });

  return connections.get(botId);
}

// بيقفل أي اتصال قديم عالق (لو موجود) وبيبلش اتصال جديد من الصفر — زر "إعادة تشغيل الاتصال" بالداشبورد بيستخدمها
// لما الاتصال يعلق "منقطع" وما عم يرجع يوصل لحاله. بيستخدم نفس ملفات الجلسة المحفوظة، فلو لسا صالحة ما بيحتاج مسح QR من جديد.
async function restartBotConnection(botId) {
  reconnectDelays.delete(botId); // منمسح أي انتظار متراكم من محاولات سابقة فاشلة، عشان المحاولة اليدوية تصير فوراً
  const existing = connections.get(botId);
  if (existing?.sock) {
    try {
      existing.sock.end(new Error("إعادة تشغيل يدوية من الداشبورد"));
    } catch (err) {
      console.warn(`[wa:${botId}] خطأ بسيط أثناء إغلاق الاتصال القديم (متجاهله):`, err.message);
    }
  }
  connections.delete(botId);

  // لو كانت الجلسة عالقة "منقطعة" أصلاً (401 ملغاة غالباً)، مسحها هون كمان — الزر هاد معناه "ابلش من جديد"،
  // فلو ضلينا نستخدم نفس الجلسة الملغاة رح نرجع نفس الخطأ من غير ما يطلع QR جديد أبداً.
  if (existing?.status === "disconnected" || existing?.status === "not_started") {
    clearAuthFolder(botId);
  }

  return startBotConnection(botId);
}

async function startAllActiveBots() {
  const bots = botStore.listBots();
  for (const bot of bots) {
    // بس بوتات "اتصال مباشر" (QR/Baileys) فعلياً — قبل هاد الإصلاح كنا نحاول نفتح اتصال Baileys
    // حتى لبوتات مربوطة بمزود مستضاف (Wasender/UltraMsg/...)، فيطلع خطأ 401 وهمي بالـ logs كل مرة السيرفر يعيد التشغيل
    // من غير أي داعي، لأنو هيك بوتات أصلاً ما إلها جلسة Baileys حقيقية مربوطة.
    if (bot.waProvider === "selfhosted" && (bot.status === "active" || bot.status === "pending_connection")) {
      startBotConnection(bot.id).catch((err) =>
        console.error(`فشل بدء اتصال البوت ${bot.name}:`, err)
      );
    }
  }
}

// معرّف جروب بواتساب دايماً منتهي بـ"@g.us" — لو كان هيك منبعته زي ما هو، وإلا منحطله لاحقة رقم شخص عادي
function toJid(to) {
  return to.includes("@g.us") || to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
}

async function sendText(botId, to, text) {
  const conn = connections.get(botId);
  if (!conn?.sock) throw new Error("هاد البوت مش متصل بواتساب بعد.");
  await conn.sock.sendMessage(toJid(to), { text });
}

async function sendImage(botId, to, imageUrl, caption = "") {
  const conn = connections.get(botId);
  if (!conn?.sock) throw new Error("هاد البوت مش متصل بواتساب بعد.");
  await conn.sock.sendMessage(toJid(to), { image: { url: imageUrl }, caption });
}

// بيرجع قائمة جروبات الواتساب المتصلة بهاد البوت (ربط مباشر عن طريق QR) — مجاني بالكامل، بدون أي وسيط خارجي،
// لأنه اتصال Baileys مباشر بواتساب نفسه.
async function getGroups(botId) {
  const conn = connections.get(botId);
  if (!conn?.sock) throw new Error("هاد البوت مش متصل بواتساب بعد.");
  const groupsMap = await conn.sock.groupFetchAllParticipating();
  return Object.values(groupsMap).map((g) => ({ jid: g.id, name: g.subject }));
}

function getQrStatus(botId) {
  const conn = connections.get(botId);
  if (!conn) return { status: "not_started", qr: null };
  return { status: conn.status, qr: conn.qr };
}

module.exports = { startBotConnection, restartBotConnection, startAllActiveBots, sendText, sendImage, getGroups, getQrStatus };
