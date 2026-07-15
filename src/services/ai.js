const env = require("../config/env");
const { buildSystemPrompt } = require("./promptBuilder");

/**
 * @param {Array<{role: "user"|"assistant", content: any}>} history
 * @param {string} userMessage
 * @param {{base64: string, mediaType: string} | null} image - صورة أرسلها الزبون (اختياري)
 * @returns {Promise<string>} رد البوت النصي
 */
async function generateReply(history, userMessage, image = null) {
  const systemPrompt = buildSystemPrompt();

  const userContent = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        { type: "text", text: userMessage || "شو رأيك بهاي الصورة؟" },
      ]
    : userMessage;

  const messages = [...history, { role: "user", content: userContent }];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.aiApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.aiModel,
      max_tokens: 500,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

module.exports = { generateReply };
