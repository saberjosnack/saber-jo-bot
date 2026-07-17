const jwt = require("jsonwebtoken");
const env = require("../config/env");

// تخزين مؤقت (بالذاكرة) لصفحات فيسبوك يلي طلعت بعد تسجيل الدخول، لحد ما صاحب البوت يختار وحدة منها.
// مؤقت لأنو بس محتاجينه لدقايق قليلة بين الرجوع من فيسبوك واختيار الصفحة، مش تخزين دائم.
const pendingPagesByBot = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 دقيقة

const GRAPH_VERSION = "v21.0";
const OAUTH_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_manage_messages",
  "business_management", // لازم عشان نقدر نجيب صفحات مربوطة بحساب أعمال (Business Manager) مش بس صفحات شخصية
].join(",");

function callbackUrl() {
  return `${env.appBaseUrl}/api/meta/facebook-callback`;
}

// ---------- الخطوة 1: بناء رابط تسجيل الدخول بفيسبوك لبوت معيّن ----------
function buildLoginUrl(botId) {
  if (!env.metaAppId) throw new Error("META_APP_ID مش محدد بإعدادات السيرفر (Render).");
  const state = jwt.sign({ botId }, env.jwtSecret, { expiresIn: "10m" });
  const params = new URLSearchParams({
    client_id: env.metaAppId,
    redirect_uri: callbackUrl(),
    state,
    scope: OAUTH_SCOPES,
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

// ---------- التحقق من قيمة state الراجعة من فيسبوك، وإرجاع رقم البوت المرتبط فيها ----------
function verifyState(state) {
  const { botId } = jwt.verify(state, env.jwtSecret);
  return botId;
}

// ---------- تبديل الكود (code) الراجع من فيسبوك بقائمة الصفحات يلي المستخدم أدمن فيها ----------
async function exchangeCodeForPages(code) {
  if (!env.metaAppId || !env.metaAppSecret) {
    throw new Error("META_APP_ID أو META_APP_SECRET مش محددين بإعدادات السيرفر.");
  }

  // 1) كود → توكن مستخدم قصير الأجل
  const tokenRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        redirect_uri: callbackUrl(),
        code,
      })
  );
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("فشل تبديل الكود: " + JSON.stringify(tokenData));

  // 2) توكن قصير → توكن مستخدم طويل الأجل (عشان توكنات الصفحات الناتجة ما تنتهي)
  const longRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        fb_exchange_token: tokenData.access_token,
      })
  );
  const longData = await longRes.json();
  const userToken = longData.access_token || tokenData.access_token;

  // 3) قائمة الصفحات يلي المستخدم أدمن فيها (مع توكن كل صفحة، وحساب انستجرام بزنس المرتبط فيها لو موجود)
  // ملاحظة: /me/accounts بترجع النتايج بصفحات (pagination) — لو الحساب عم يدير صفحات كتيرة
  // (متل هاد الحساب يلي عنده عشرات الصفحات لأعمال مختلفة)، الصفحة يلي بدنا ياها ممكن تكون
  // مش بأول دفعة نتايج. لازم نلف على كل صفحات النتايج (paging.next) لحتى نجمعهم كلهم.
  const meAccountsPages = await fetchAllPages(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?` +
      new URLSearchParams({
        fields: "id,name,access_token,instagram_business_account{id,username}",
        limit: "100",
        access_token: userToken,
      })
  );

  let pages = meAccountsPages;

  // بعض الصفحات المدارة عن طريق حساب أعمال (Business Manager) — متل صفحات مربوطة "بالتعيين"
  // كموظف على مستوى الأعمال مش عن طريق صلاحيات الصفحة الكلاسيكية — ما بترجع من /me/accounts
  // مهما لفينا على كل صفحاته. إذا محدد META_BUSINESS_ID، منجيبهم كمان من نقطة الأعمال ومنضمهم.
  if (env.metaBusinessId) {
    try {
      const businessPages = await fetchAllPages(
        `https://graph.facebook.com/${GRAPH_VERSION}/${env.metaBusinessId}/owned_pages?` +
          new URLSearchParams({
            fields: "id,name,access_token,instagram_business_account{id,username}",
            limit: "100",
            access_token: userToken,
          })
      );
      const existingIds = new Set(pages.map((p) => p.id));
      for (const p of businessPages) {
        if (!existingIds.has(p.id)) pages.push(p);
      }
    } catch (err) {
      console.error("[meta-auth] تعذّر جلب صفحات حساب الأعمال (owned_pages) — رح نكمل بس بصفحات /me/accounts:", err.message);
    }
  }

  return pages;
}

// يلف على كل صفحات النتايج (paging.next) لأي رابط Graph API ويرجع مصفوفة واحدة مجمّعة
async function fetchAllPages(firstUrl) {
  let results = [];
  let nextUrl = firstUrl;
  while (nextUrl) {
    const res = await fetch(nextUrl);
    const data = await res.json();
    if (!Array.isArray(data.data)) throw new Error("فشل جلب الصفحات: " + JSON.stringify(data));
    results = results.concat(data.data);
    nextUrl = data.paging?.next || null;
  }
  return results;
}

function savePendingPages(botId, pages) {
  pendingPagesByBot.set(botId, { pages, savedAt: Date.now() });
}

function getPendingPages(botId) {
  const entry = pendingPagesByBot.get(botId);
  if (!entry) return [];
  if (Date.now() - entry.savedAt > PENDING_TTL_MS) {
    pendingPagesByBot.delete(botId);
    return [];
  }
  return entry.pages;
}

// بيرجع الصفحة المختارة كاملة (مع التوكن). ما بنمسح باقي الصفحات المعلّقة —
// لو المستخدم اختار أكتر من صفحة بشاشة فيسبوك، لازم تضل باقي الصفحات متاحة
// لين تنتهي صلاحيتها (TTL) أو يسجل دخول من جديد، عشان ما تضيع لو غلط بالاختيار.
function consumeSelectedPage(botId, pageId) {
  const pages = getPendingPages(botId);
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;
  return page;
}

module.exports = {
  buildLoginUrl,
  verifyState,
  exchangeCodeForPages,
  savePendingPages,
  getPendingPages,
  consumeSelectedPage,
};
