const store = require("./store");

// نفس معادلة حساب مسافة خط مستقيم (Haversine) المستخدمة بموقع منيو-sjs الثابت — نطاق الأرض بالكيلومتر.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// نفس معادلة رسم التوصيل المستخدمة بموقع منيو-sjs: رسم أساسي (base) يغطي أول (freeKm) كم، وبعدها
// (perKm) لكل كم إضافي، وبنقرّب لفوق لأقرب دينار كامل بعد ما نتجاوز المسافة المجانية.
// كل القيم متغيّرة ومحفوظة بإعدادات كل بوت (settings.delivery) — مو ثابتة بالكود متل الموقع القديم.
function calcDeliveryFee(distanceKm, deliveryConfig) {
  const base = Number(deliveryConfig?.base) || 1.5;
  const freeKm = Number(deliveryConfig?.freeKm) || 2;
  const perKm = Number(deliveryConfig?.perKm) || 0.27;

  if (distanceKm <= freeKm) return base; // رسم ثابت بدون تقريب جوا نطاق المسافة المجانية
  const extra = distanceKm - freeKm;
  const raw = base + extra * perKm;
  return Math.ceil(raw); // بعد المسافة المجانية، نقرّب لفوق لأقرب دينار كامل
}

// أقرب فرع لموقع الزبون (خط مستقيم — بس لتحديد "مين أقرب فرع"، مش لحساب رسم التوصيل نفسه)
function nearestBranch(branches, lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const b of branches || []) {
    if (typeof b?.lat !== "number" || typeof b?.lng !== "number") continue;
    const d = haversineKm(lat, lng, b.lat, b.lng);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best ? { branch: best, straightKm: bestDist } : null;
}

// مسافة الطريق الفعلية (مش خط مستقيم) عن طريق OSRM العامة — عشان الرسم يعكس الطرق الملتوية/التلال فعلياً.
// لو الـ API ما استجاب أو صار خطأ، بنرجع لتقدير احتياطي: خط مستقيم × 1.3 (نفس نسبة الموقع القديم لعمّان)،
// عشان تدفق حساب رسم التوصيل ما يعلق أبداً حتى لو OSRM واقع مؤقتاً.
async function getRoadDistanceKm(lat1, lng1, lat2, lng2) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code === "Ok" && data.routes?.[0]) {
      return { km: data.routes[0].distance / 1000, estimated: false };
    }
    throw new Error("no route");
  } catch (err) {
    const straight = haversineKm(lat1, lng1, lat2, lng2);
    return { km: straight * 1.3, estimated: true };
  }
}

// بيحوّل الإحداثيات لعنوان مقروء (عربي) عن طريق Nominatim (OpenStreetMap) — عشان البوت "يحدد العنوان لحاله"
// من موقع الزبون بدل ما يسأله يكتبه، بدون ما نحتاج أي مفتاح API. Best-effort: لو فشل أو رجع فاضي، منرجع null
// والمحادثة بتكمل عادي بس بدون نص عنوان (الإحداثيات والمسافة والرسم لسا موجودين ومحسوبين صح).
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ar&zoom=18`;
    const res = await fetch(url, {
      headers: { "User-Agent": "saber-jo-bot/1.0 (delivery-location-lookup)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.display_name || null;
  } catch (err) {
    return null;
  }
}

/**
 * بيحسب كل شي متعلق بتوصيل موقع مباشر بعته الزبون (Live/Pin Location) لبوت معيّن:
 * أقرب فرع، مسافة الطريق الفعلية، رسم التوصيل المحسوب حسب إعدادات هاد البوت بالضبط، والعنوان التقريبي.
 * @param {string} configId
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{lat:number,lng:number,address:string|null,branch:object|null,distanceKm:number|null,fee:number|null,estimated:boolean}>}
 */
async function computeLocationDelivery(configId, lat, lng) {
  const settings = store.read(`configs/${configId}/settings.json`);
  const branches = store.exists(`configs/${configId}/branches.json`) ? store.read(`configs/${configId}/branches.json`) : [];
  const deliveryConfig = settings?.delivery || {};

  const nearest = nearestBranch(branches, lat, lng);

  // العنوان ومحاولة إيجاد أقرب فرع (والمسافة/الرسم لو في فروع) بالتوازي — ما في داعي ننتظرهم بالتسلسل
  const [address, roadResult] = await Promise.all([
    reverseGeocode(lat, lng),
    nearest ? getRoadDistanceKm(lat, lng, nearest.branch.lat, nearest.branch.lng) : Promise.resolve(null),
  ]);

  if (!nearest || !roadResult) {
    return { lat, lng, address, branch: null, distanceKm: null, fee: null, estimated: false };
  }

  const distanceKm = Math.round(roadResult.km * 100) / 100;
  const fee = calcDeliveryFee(roadResult.km, deliveryConfig);

  return { lat, lng, address, branch: nearest.branch, distanceKm, fee, estimated: roadResult.estimated };
}

module.exports = { haversineKm, calcDeliveryFee, nearestBranch, getRoadDistanceKm, reverseGeocode, computeLocationDelivery };
