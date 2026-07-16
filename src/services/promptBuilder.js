const store = require("./store");

const SALES_POWER_TEXT = {
  light: "سجّل الطلب واجاوب على أسئلة الزبون بس، بلا ما تقترح إضافات.",
  mid: "اقترح إضافة أو عرض بس لو الفرصة مناسبة طبيعياً بالمحادثة، بدون إلحاح.",
  strong: "حاول تزيد قيمة كل طلب — اقترح إضافات، تكبير حجم، أو عروض العائلة، بأسلوب ودود مو مزعج.",
};

const GUARDRAIL_TEXT = {
  "no-prices": "ما تخترع أسعار مش موجودة بقائمة المنيو.",
  "no-competitors": "ما تذكر أي مطعم أو منافس إطلاقاً.",
  neutral: "ابقى محايد إذا انجرّت المحادثة لمواضيع حساسة أو مثيرة للجدل.",
  "no-medical": "ما تقدم نصائح شخصية أو طبية أو قانونية.",
  "no-fake-promise": "ما تعطي وعود كاذبة عن مواعيد توصيل أو اتصالات.",
  privacy: "احمِ خصوصية بيانات الزبون، وما تشاركها مع أي طرف.",
  "no-repeat": "تجنب تكرار نفس الرد بشكل يضايق الزبون.",
  "no-links": "ما تشارك روابط خارجية.",
  "stay-on-topic": "ابقى بموضوع الطلب، ولو الزبون حاد عنه رجّعه بلطف.",
  "no-inappropriate": "احظر أي محتوى غير لائق بالمحادثة.",
};

function isOpenNow(openTime, closeTime, nowJordan = new Date()) {
  // ساعات دوام تعدّي منتصف الليل (مثلاً 15:00 → 04:30)
  const [oh, om] = openTime.split(":").map(Number);
  const [ch, cm] = closeTime.split(":").map(Number);
  const minutesNow = nowJordan.getHours() * 60 + nowJordan.getMinutes();
  const openMinutes = oh * 60 + om;
  const closeMinutes = ch * 60 + cm;

  if (openMinutes > closeMinutes) {
    // بيعدّي منتصف الليل
    return minutesNow >= openMinutes || minutesNow < closeMinutes;
  }
  return minutesNow >= openMinutes && minutesNow < closeMinutes;
}

function buildSystemPrompt(configId = "default") {
  const settings = store.read(`configs/${configId}/settings.json`);
  const menu = store.read(`configs/${configId}/menu.json`);
  const fees = store.read(`configs/${configId}/deliveryFees.json`);

  const { identity, style, guardrails, customRules, prompt } = settings;

  const open = isOpenNow(identity.openTime, identity.closeTime);

  const menuText = menu
    .map((item) => {
      const price = item.price !== null ? `${item.price} د.أ` : "السعر غير مسجل بعد بالنظام";
      const avail = item.available ? "متوفر" : "غير متوفر حالياً";
      const featured = item.featured ? ` — [صنف مميز: ${item.featuredNote || "يُنصح باقتراحه"}]` : "";
      return `- ${item.name} (${item.category}): ${price}، ${avail}${featured}`;
    })
    .join("\n");

  const guardrailText = Object.entries(guardrails)
    .filter(([, on]) => on)
    .map(([id]) => `- ${GUARDRAIL_TEXT[id] || id}`)
    .join("\n");

  const rulesText = customRules.map((r) => `- ${r}`).join("\n");

  return `
اسمك "${identity.employeeName}" — موظف بشري بمطعم Saber Jo Snack بعمّان (فرع طلوع الحوانا، شارع الجامعة الأردنية). المطعم توصيل واستلام بس، بدون تناول بالمكان.

أوقات الدوام: من ${identity.openTime} لـ ${identity.closeTime}.
حالة المطعم هلأ: ${open ? "فاتح" : "مسكر"}.
${open ? "" : "إذا سأل الزبون عن الطلب هلأ، أخبره بلطف إنو المطعم مسكر هلأ ووضحله وقت الفتح."}

نبرة الحكي: ${style.tones.join("، ")}. مستوى استخدام الإيموجي: ${style.emojiLevel}. حاول تخلي ردودك تحت ${style.responseLength} حرف تقريباً.

قوة البيع: ${SALES_POWER_TEXT[identity.salesPower]}

قائمة المنيو الحالية (السعر والتوفر من النظام مباشرة، ما تخترع غيرها):
${menuText}

مناطق التوصيل مسجلة برسوم ثابتة لكل منطقة (${fees.length} منطقة بالنظام). اسأل عن المنطقة بالضبط قبل ما تأكد أي سعر توصيل، وإذا المنطقة مش موجودة بالنظام، اعتذر وقول التوصيل مش متاح إلها واعرض الاستلام من الفرع.

حواجز الأمان:
${guardrailText}

قواعد إضافية خاصة بالمطعم:
${rulesText}

${prompt}
`.trim();
}

module.exports = { buildSystemPrompt, isOpenNow };
