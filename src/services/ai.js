const env = require("../config/env");
const { buildSystemPrompt, buildCustomerProfileSection, buildDiscountSection, buildLocationSection } = require("./promptBuilder");

// أداة تسجيل الطلب — الموديل يستدعيها لما الزبون يأكد كل تفاصيل طلبه صراحة (اسمها بالبرومبت أيضاً، شوف promptBuilder.js).
// لما تنستدعى، منسجل الطلب بلوحة التحكم ومنبعته لجروب الواتساب (لو مفعّل) بشكل منفصل تماماً عن أي شي الموديل شافه أو قاله للزبون.
const ORDER_TOOL = {
  name: "record_order",
  description:
    "سجّل طلب الزبون فور ما يأكد كل تفاصيله صراحة (الأصناف والكمية، طريقة الاستلام، ورقم تواصل لو أعطاك واحد مختلف عن رقمه الحالي). استخدمها مرة وحدة بس لكل طلب مؤكد — ما تستخدمها لو الزبون لسا عم يسأل أو يفكر.",
  input_schema: {
    type: "object",
    properties: {
      itemsSummary: {
        type: "string",
        description: "ملخص الأصناف والكميات يلي أكدها الزبون بالضبط، مثال: '2x زنجر, 1x كومبو عائلي'",
      },
      fulfillment: {
        type: "string",
        enum: ["delivery", "pickup"],
        description: "طريقة الاستلام: delivery (توصيل) أو pickup (استلام من الفرع)",
      },
      area: {
        type: "string",
        description: "لو توصيل: المنطقة أو العنوان يلي أكده الزبون (أو العنوان المحسوب من الموقع المباشر لو بعته). لو استلام، اتركها فاضية واستخدم حقل branch بدالها.",
      },
      branch: {
        type: "string",
        description: "لو استلام من الفرع: اسم الفرع بالضبط يلي الزبون رح يستلم منه (من قائمة الفروع بالأعلى). اتركها فاضية لو توصيل.",
      },
      subtotal: {
        type: "number",
        description: "مجموع سعر الأصناف بس (بدون رسم التوصيل)، بعد ما تطرح أي خصم مؤكد (قسم 'خصم الزبون' لو ظهر). اتركها فاضية إذا في سعر صنف مش مسجل بعد.",
      },
      deliveryFee: {
        type: "number",
        description: "رسم التوصيل بالدينار — استخدم الرقم المحسوب فعلياً (من قسم الموقع المباشر أو من قائمة المناطق). اتركها فاضية أو 0 لو استلام من الفرع.",
      },
      totalPrice: {
        type: "number",
        description: "المجموع الكلي = subtotal + deliveryFee (0 لو استلام). اتركها فاضية إذا subtotal مش معروف بعد.",
      },
      customerName: { type: "string", description: "اسم الزبون لو انذكر بالمحادثة" },
      contactPhone: { type: "string", description: "رقم تواصل بديل لو الزبون أعطاك واحد غير رقمه الحالي" },
      contactMethod: {
        type: "string",
        description: "طريقة التواصل المفضلة يلي حددها الزبون صراحة لمتابعة طلبه (مثلاً 'واتساب' أو 'اتصال هاتفي' أو غيرها). اتركها فاضية لو ما حدد شي.",
      },
      notes: { type: "string", description: "أي ملاحظات إضافية بالطلب (وقت توصيل مفضّل، طلب خاص، حجز لوقت الفتح لو المحل مسكر هلأ، إلخ)" },
    },
    required: ["itemsSummary", "fulfillment"],
  },
};

// أداة إرسال صورة صنف — استعملها الموديل بوعي بحالتين بس: الزبون طلب صورة صراحة، أو الزبون محتار وقرر
// يغريه بصنف معيّن. هاي بديل عن الطريقة القديمة (فحص نص الرد بحثاً عن أسماء أصناف) يلي كانت ترسل صور
// لمجرد إنو اسم الصنف انذكر بالرد ولو بسياق عادي — الأداة هلأ بتخلي الإرسال قرار واعي من الموديل نفسه.
const SEND_PHOTO_TOOL = {
  name: "send_photo",
  description:
    "استخدمها بس بحالتين: (1) الزبون طلب صراحة يشوف صورة صنف، أو (2) الزبون محتار مش عارف شو يطلب وقررت توصيله بصنف معيّن وحابب تغريه بصورته. ما تستخدمها لمجرد ذكر اسم صنف بسياق عادي بردك — الاستخدام الزايد بزعج الزبون بصور ما طلبها.",
  input_schema: {
    type: "object",
    properties: {
      itemName: { type: "string", description: "اسم الصنف بالضبط أو أقرب صيغة له متل ما هو مسجل بقائمة المنيو" },
    },
    required: ["itemName"],
  },
};

/**
 * @param {Array<{role: "user"|"assistant", content: any}>} history
 * @param {string} userMessage
 * @param {{base64: string, mediaType: string} | null} image - صورة أرسلها الزبون (اختياري)
 * @param {string} configId - أي بوت/قالب إعدادات نستخدم
 * @param {{name?:string, phone?:string, area?:string, lastItems?:string[], lastOrderAt?:string} | null} customerProfile - بيانات الزبون من طلب سابق (لو موجودة)
 * @param {{vip?: {percent:number,name:string|null}, code?: {code:string,kind:string,value:number}} | null} discountContext - خصم VIP أو كود خصم متأكد منه لهالرسالة (لو في)
 * @param {{address?:string|null, branch?:object|null, distanceKm?:number|null, fee?:number|null, estimated?:boolean} | null} locationContext - موقع مباشر بعته الزبون بهالرسالة، محسوب سلفاً (deliveryCalc.js)
 * @returns {Promise<{reply: string, order: object|null, requestedPhotos: string[]}>} رد البوت النصي + تفاصيل الطلب لو تأكد هالرسالة + أسماء أي صور صنف قرر الموديل يرسلها بوعي
 */
async function generateReply(history, userMessage, image = null, configId = "default", customerProfile = null, discountContext = null, locationContext = null) {
  const systemPrompt = buildSystemPrompt(configId);
  // بيانات الزبون + الخصم + الموقع منفصلين عن البرومبت الثابت أعلاه — عمداً بدون cache_control، عشان ما نكسر كاش
  // البرومبت الكبير (منيو/إعدادات) يلي مشترك بين كل الزبائن. هاي بلوكات صغيرة خاصة بهاد الزبون/الرسالة بس.
  const customerSection = buildCustomerProfileSection(customerProfile);
  const discountSection = buildDiscountSection(discountContext);
  const locationSection = buildLocationSection(locationContext);

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
        ...(discountSection ? [{ type: "text", text: discountSection }] : []),
        ...(locationSection ? [{ type: "text", text: locationSection }] : []),
      ],
      messages,
      tools: [ORDER_TOOL, SEND_PHOTO_TOOL],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  const toolBlock = data.content.find((b) => b.type === "tool_use" && b.name === "record_order");
  const photoBlocks = data.content.filter((b) => b.type === "tool_use" && b.name === "send_photo");

  return {
    reply: textBlock ? textBlock.text : "",
    order: toolBlock ? toolBlock.input : null,
    requestedPhotos: photoBlocks.map((b) => b.input?.itemName).filter(Boolean),
  };
}

// شبكة أمان: أحياناً الموديل بيكتب للزبون نص تأكيد ("الطلب تم تسجيله بنجاح") بدون ما ينادي فعلياً على
// أداة record_order بنفس الرد — يعني الزبون بيتطمن إنو طلبه انسجل بس فعلياً ما انسجل شي بلوحة التحكم ولا انبعت لجروب الواتساب.
// هاي دالة تصحيحية: منرجع نعطي الموديل نفس المحادثة (شامل رده يلي أكد فيه الطلب) ومنجبره (tool_choice) إنو
// ينادي record_order فوراً ويستخرج تفاصيل نفس الطلب يلي أكده لتوّه، بدون ما نرسل أي شي إضافي للزبون.
async function recoverMissedOrder(configId, history, userMessage, assistantReply) {
  const systemPrompt = buildSystemPrompt(configId);

  const messages = [
    ...history,
    { role: "user", content: userMessage || "[صورة]" },
    { role: "assistant", content: assistantReply },
    {
      role: "user",
      content:
        "[ملاحظة نظام غير مرئية للزبون]: أكدت فوق للزبون إنو الطلب انسجل بنجاح. نادي حالاً على أداة record_order واستخرج منها تفاصيل نفس الطلب يلي أكدته له بالضبط (الأصناف، المنطقة، السعر لو مذكور، الاسم، الهاتف).",
    },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.aiApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.aiModel,
      max_tokens: 300,
      temperature: 0,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
      tools: [ORDER_TOOL],
      tool_choice: { type: "tool", name: "record_order" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error أثناء استرجاع الطلب الفائت (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const toolBlock = data.content.find((b) => b.type === "tool_use" && b.name === "record_order");
  return toolBlock ? toolBlock.input : null;
}

// عبارات بتدل إنو الموديل أكد للزبون تسجيل الطلب — لو ظهرت بالرد بدون ما ينادي record_order، هاد مؤشر
// قوي إنو في طلب "ضاع" (اتأكد للزبون بس ما انسجل)، ولازم نحاول نسترجعه فوراً.
const ORDER_CONFIRMATION_PATTERNS = [
  "تم تسجيل",
  "تسجيله بنجاح",
  "تم تأكيد الطلب",
  "انسجل طلبك",
  "طلبك انسجل",
  "تم استلام طلبك",
  "الطلب تم",
];

function looksLikeMissedOrderConfirmation(replyText) {
  if (!replyText) return false;
  return ORDER_CONFIRMATION_PATTERNS.some((p) => replyText.includes(p));
}

module.exports = { generateReply, recoverMissedOrder, looksLikeMissedOrderConfirmation };
