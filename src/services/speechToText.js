const env = require("../config/env");

/**
 * بيحوّل ملف صوتي (buffer) لنص عن طريق Whisper API من OpenAI.
 * بيرجع null لو ما في مفتاح OpenAI مسجل، أو لو صار خطأ بالتحويل — بدل ما يوقف كل شي بخطأ.
 *
 * @param {Buffer} audioBuffer
 * @param {string} filename - مثلاً "voice.ogg" أو "voice.mp3" (Whisper بيحدد النوع من الامتداد)
 * @returns {Promise<string|null>}
 */
async function transcribeAudio(audioBuffer, filename = "voice.ogg") {
  if (!env.openaiApiKey) {
    console.warn("[speech-to-text] ما في OPENAI_API_KEY مسجل — ما قدرت أحوّل الرسالة الصوتية لنص.");
    return null;
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), filename);
    form.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiApiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[speech-to-text] خطأ من OpenAI (${res.status}):`, errText);
      return null;
    }

    const data = await res.json();
    return data.text || null;
  } catch (err) {
    console.error("[speech-to-text] فشل تحويل الصوت لنص:", err.message);
    return null;
  }
}

module.exports = { transcribeAudio };
