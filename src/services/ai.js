const env = require("../config/env");
const { buildSystemPrompt, buildCustomerProfileSection } = require("./promptBuilder");

// أداة تسجيل الطلب — الموديل يستدعيها لما الزبون يأكد كل تفاصيل طلبه صراحة (اسمها بالبرومبت أيضاً، شوف promptBuilder.js).
// لما تنستدعى، منسجل الطلب بلوحة التحكم ومنبعته لجروب الواتساب (لو مفعّل) بشكل منفصل تماماً عن أي شي الموديل شافه أو قاله للزبون.
const ORDER_TOOL = {
  name: "record_order",
  description:
    "سجّل طلب الزبون فور ما يأكد كل تفاصيله صراحة (الأصناف والكمية، ومنطقة التوصيل أو الاستلام، ورقم تواصل لو أعطاك واحد مختلف عن رقمه الحالي). استخدمها مرة وحدة بس لكل طلب مؤكد — ما تستخدمها لو الزبون لسا عم يسأل أو يفكر.",
  input_schema: {
    type: "object",
    properties: {
      itemsSummary: {
        type: "string",
        description: "ملخص الأصناف والكميات يلي أكدها الزبون بالضبط، مثال: '2x زنجر, 1x كومبو عائلي'",
      },
      area: {
        type: "string",
        description: "منطقة التوصيل يلي أكدها الزبون، أو 'استلام من الفرع' لو رح يجي يستلم",
      },
      totalPrice: {
        type: "number",
        description: "المجموع الكلي بالدينار الأردني إذا كانت كل الأسعار معروفة من المنيو ورسوم التوصيل. اتركها فاضية إذا في سعر مش مسجل بعد.",
      },
      customerName: { type: "string", description: "اسم الزبون لو انذكر بالمحادثة" },
      contactPhone: { type: "string", description: "رقم تواصل بديل لو الزبون أعطاك واحد غير رقمه الحالي" },
      notes: { type: "string", description: "أي ملاحظات إضافية بالطلب (وقت توصيل مفضّل، طلب خاص، إلخ)" },
    },
    required: ["itemsSummary", "area"],
  },
};

/**
 * @param {Array<{role: "user"|"assistant", content: any}>} history
 * @param {string} userMessage
 * @param {{base64: string, mediaType: string} | null} image - صورة أرسلها الزبون (اختياري)
 * @param {string} configId - أي بوت/قالب إعدادات نستخدم
 * @param {{name?:string, phone?:string, area?:string, lastItems?:string[], lastOrderAt?:string} | null} customerProfile - بيانات الزبون من طلب سابق (لو موجودة)
 * @returns {Promise<{reply: string, order: object|null}>} رد البوت النصي + تفاصيل الطلب لو تأكد هالرسالة
 */
async function generateReply(history, userMessage, image = null, configId = "default", customerProfile = null) {
  const systemPrompt = buildSystemPrompt(configId);
  // بيانات الزبون منفصلة عن البرومبت الثابت أعلاه — عمداً بدون cache_control، عشان ما نكسر كاش
  // البرومبت الكبير (منيو/إعدادات) يلي مشترك بين كل الزبائن. هاي بلوك صغير خاص بهاد الزبون بس.
  const customerSection = buildCustomerProfileSection(customerProfile);

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
      max_tokens: 600,
      // درجة حرارة متوسطة: كفاية عشان الصياغة تختلف من رد لرد (ما يبين البوت مكرر/آلي قدام ميتا)،
      // بس القواعد الصارمة بالبرومبت (منع اختلاق أسعار/أصناف) بتضل مطبقة بغض النظر عن الحرارة.
      temperature: 0.45,
      // الجزء الثابت (منيو، توصيل، حواجز) بيتخزن مؤقتاً — كل رسالة بعدها بتدفع 10% بس من سعره.
      // بلوك بيانات الزبون (لو موجود) منفصل وبدون تخزين مؤقت، عشان ما يكسر الكاش المشترك بين كل الزبائن.
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ...(customerSection ? [{ type: "text", text: customerSection }] : []),
      ],
      messages,
      tools: [ORDER_TOOL],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  const toolBlock = data.content.find((b) => b.type === "tool_use" && b.name === "record_order");

  return {
    reply: textBlock ? textBlock.text : "",
    order: toolBlock ? toolBlock.input : null,
  };
}

module.exports = { generateReply };
