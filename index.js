/**
 * 旅の友 - Cloudflare Worker 後端
 * 資料庫：Cloudflare D1 (SQLite)
 * 綁定名稱：DB
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), { headers: CORS });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ success: false, error: msg }), { status, headers: CORS });
}

// ═══════════════════════════════════════════
//  成員設定（修改這裡新增 / 刪除成員）
// ═══════════════════════════════════════════
const MEMBERS = [
  { name: "小秉", emoji: "🧑", color: "#E8A0B4", role: "" },
  { name: "董董", emoji: "👩", color: "#B5D4F4", role: "" },
  { name: "陳皮", emoji: "👧", color: "#C0DD97", role: "" },
  { name: "阿涵", emoji: "👧", color: "#FAC775", role: "" },
  { name: "熊熊", emoji: "🧑", color: "#FAC775", role: "" },
  { name: "海獺", emoji: "👧", color: "#FAC775", role: "" },
];

// ═══════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const url    = new URL(request.url);
    const path   = url.pathname;
    const member = url.searchParams.get("member") || "";

    try {
      if (request.method === "GET") {
        if (path === "/api/members")            return ok(MEMBERS);
        if (path === "/api/schedule")           return ok(await getSchedule(env));
        if (path === "/api/restaurants/master") return ok(await getMasterRestaurants(env));
        if (path === "/api/spots/master")       return ok(await getMasterSpots(env));
        if (path === "/api/expenses")           return ok(await getExpenses(env, member));
        if (path === "/api/tax/batches")        return ok(await getTaxBatches(env, member));
        if (path === "/api/restaurants/mine")   return ok(await getMyRestaurants(env, member));
        if (path === "/api/spots/mine")         return ok(await getMySpots(env, member));
        if (path === "/api/packing")            return ok(await getPacking(env, member));
        if (path === "/api/sub-schedules")      return ok(await getSubSchedules(env, member));
        if (path === "/api/admin/seed")           return ok(await seedMasterData(env));
      }

      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (path === "/api/expenses")                return ok(await addExpense(env, member, body));
        if (path === "/api/expenses/delete")         return ok(await deleteExpenseWithSync(env, body.id));
        if (path === "/api/expenses/update-refund")  return ok(await updateExpenseRefundWithSync(env, body));
        if (path === "/api/expenses/update")         return ok(await updateExpenseWithSync(env, body));
        if (path === "/api/tax/batches")             return ok(await createTaxBatch(env, member, body));
        if (path === "/api/tax/batches/finish")      return ok(await finishTaxBatch(env, body));
        if (path === "/api/tax/batches/delete")      return ok(await deleteTaxBatch(env, body.id));
        if (path === "/api/tax/expenses/toggle")     return ok(await toggleExpenseBatchWithSync(env, body));
        if (path === "/api/restaurants/mine")   return ok(await addMyRestaurant(env, member, body));
        if (path === "/api/restaurants/delete") return ok(await deleteMyRestaurant(env, member, body.id));
        if (path === "/api/spots/mine")         return ok(await addMySpot(env, member, body));
        if (path === "/api/spots/delete")       return ok(await deleteMySpot(env, member, body.id));
        if (path === "/api/packing")            return ok(await addPackingItem(env, member, body));
        if (path === "/api/packing/toggle")     return ok(await togglePacking(env, body.id, body.checked));
        if (path === "/api/sub-schedules")          return ok(await addSubSchedule(env, member, body));
        if (path === "/api/sub-schedules/add-manual") return ok(await addSubSchedule(env, member, body));
        if (path === "/api/sub-schedules/delete")   return ok(await deleteSubSchedule(env, body.id));
        if (path === "/api/sub-schedules/reorder")  return ok(await reorderSubSchedules(env, body.items));
        if (path === "/api/admin/seed")         return ok(await seedMasterData(env));
      }

      return err("Not found", 404);
    } catch (e) {
      console.error(e);
      return err(e.message, 500);
    }
  }
};

// ═══════════════════════════════════════════
//  SCHEDULE
// ═══════════════════════════════════════════
async function getSchedule(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM schedule ORDER BY day ASC, time ASC"
  ).all();
  return results;
}

// ═══════════════════════════════════════════
//  MASTER DATA
// ═══════════════════════════════════════════
async function getMasterRestaurants(env) {
  const { results } = await env.DB.prepare("SELECT * FROM master_restaurants ORDER BY id ASC").all();
  return results;
}
async function getMasterSpots(env) {
  const { results } = await env.DB.prepare("SELECT * FROM master_spots ORDER BY id ASC").all();
  return results;
}

// ═══════════════════════════════════════════
//  EXPENSES  (含 payment_method)
// ═══════════════════════════════════════════
async function getExpenses(env, member) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM expenses WHERE member = ? ORDER BY created_at DESC"
  ).bind(member).all();
  return results;
}

async function getExpenseById(env, id) {
  return await env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first();
}

function calcExpenseRawRefund(amount, taxType) {
  const am = Number(amount) || 0;
  if (taxType === "tax10") return Math.round(am / 1.1 * 0.1);
  if (taxType === "tax8") return Math.round(am / 1.08 * 0.08);
  return 0;
}

async function recalcTaxBatch(env, batchId) {
  const id = Number(batchId) || 0;
  if (!id) return null;

  const batch = await env.DB.prepare(
    "SELECT * FROM tax_refund_batches WHERE id = ?"
  ).bind(id).first();
  if (!batch) return null;

  const { results: expenses } = await env.DB.prepare(
    "SELECT id, amount, tax_type FROM expenses WHERE refund_batch_id = ? ORDER BY created_at ASC"
  ).bind(id).all();

  const totalRaw = expenses.reduce(
    (sum, exp) => sum + calcExpenseRawRefund(exp.amount, exp.tax_type),
    0
  );
  const serviceFee = Number(batch.service_fee || 0);
  const finalRefundReceived = Math.max(0, totalRaw - serviceFee);

  await env.DB.prepare(
    `UPDATE tax_refund_batches
     SET total_raw_refund=?, final_refund_received=?
     WHERE id=?`
  ).bind(totalRaw, finalRefundReceived, id).run();

  return {
    id,
    total_raw_refund: totalRaw,
    service_fee: serviceFee,
    final_refund_received: finalRefundReceived,
  };
}

async function addExpense(env, member, body) {
  const { name, amount, category, expense_date, note, payment_method,
          tax_type, refund_status, shop_group } = body;
  const effectiveTaxType = tax_type || "none";
  const effectiveStatus  = effectiveTaxType !== "none" ? (refund_status || "pending") : "none";
  const res = await env.DB.prepare(
    `INSERT INTO expenses
       (member,name,amount,category,expense_date,note,payment_method,
        tax_type,refund_status,refund_batch_id,shop_group,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,datetime('now','+8 hours')) RETURNING id`
  ).bind(
    member, name, amount,
    category       || "其他",
    expense_date   || "",
    note           || "",
    payment_method || "現金",
    effectiveTaxType,
    effectiveStatus,
    shop_group     || ""
  ).first();
  return { id: res.id };
}


async function updateExpenseRefund(env, body) {
  // 更新單筆花費的退稅狀態（從批次管理頁面取消勾選用）
  const { id, refund_status, refund_batch_id, shop_group } = body;
  await env.DB.prepare(
    "UPDATE expenses SET refund_status=?, refund_batch_id=?, shop_group=? WHERE id=?"
  ).bind(refund_status||"none", refund_batch_id||0, shop_group||"", id).run();
  return { updated: id };
}

async function deleteExpense(env, id) {
  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  return { deleted: id };
}

async function updateExpense(env, body) {
  const { id, name, amount, category, expense_date, note, payment_method,
          tax_type, refund_status, shop_group } = body;
  const effectiveTaxType   = tax_type || "none";
  const effectiveRefStatus = effectiveTaxType !== "none" ? (refund_status || "pending") : "none";
  await env.DB.prepare(
    `UPDATE expenses SET
       name=?, amount=?, category=?, expense_date=?,
       note=?, payment_method=?, tax_type=?, refund_status=?, shop_group=?
     WHERE id=?`
  ).bind(
    name, amount,
    category || "其他",
    expense_date || "",
    note || "",
    payment_method || "現金",
    effectiveTaxType,
    effectiveRefStatus,
    shop_group || "",
    id
  ).run();
  return { updated: id };
}

// ═══════════════════════════════════════════
//  TAX REFUND BATCHES
// ═══════════════════════════════════════════
async function getTaxBatches(env, member) {
  // 取批次 + 每批次的關聯花費
  const { results: batches } = await env.DB.prepare(
    "SELECT * FROM tax_refund_batches WHERE member=? ORDER BY created_at DESC"
  ).bind(member).all();

  // 取所有 pending/completed 的退稅花費
  const { results: expenses } = await env.DB.prepare(
    "SELECT * FROM expenses WHERE member=? AND tax_type != 'none' ORDER BY expense_date DESC, created_at DESC"
  ).bind(member).all();

  return { batches, expenses };
}

async function createTaxBatch(env, member, body) {
  const { location, location_type } = body;
  const res = await env.DB.prepare(
    `INSERT INTO tax_refund_batches (member,location,location_type,status,created_at)
     VALUES (?,?,?,'processing',datetime('now','+8 hours')) RETURNING id`
  ).bind(member, location, location_type||"street").first();
  return { id: res.id };
}

async function finishTaxBatch(env, body) {
  const { id, total_raw_refund, final_refund_received, service_fee, expense_ids } = body;

  // 優先用使用者填寫的「原始退稅額」，沒填才用系統估算
  let total_raw = (total_raw_refund != null && total_raw_refund > 0) ? Number(total_raw_refund) : 0;
  if (!total_raw && expense_ids?.length) {
    const placeholders = expense_ids.map(()=>"?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id, amount, tax_type FROM expenses WHERE id IN (${placeholders})`
    ).bind(...expense_ids).all();
    total_raw = results.reduce((sum, e) => {
      if (e.tax_type === "tax10") return sum + Math.round(e.amount / 1.1 * 0.1);
      if (e.tax_type === "tax8")  return sum + Math.round(e.amount / 1.08 * 0.08);
      return sum;
    }, 0);
  }

  // 不管 total_raw 從哪來，只要有 expense_ids 就要更新狀態
  if (expense_ids?.length) {
    const updateStmt = env.DB.prepare(
      "UPDATE expenses SET refund_status='completed', refund_batch_id=? WHERE id=?"
    );
    await env.DB.batch(expense_ids.map(eid => updateStmt.bind(id, eid)));
  }

  // 更新批次
  await env.DB.prepare(
    `UPDATE tax_refund_batches
     SET status='finished', total_raw_refund=?, service_fee=?, final_refund_received=?
     WHERE id=?`
  ).bind(total_raw, service_fee||0, final_refund_received||0, id).run();

  return {
    id,
    total_raw_refund: total_raw,
    service_fee: service_fee || 0,
    final_refund_received: final_refund_received || 0,
    net_refund: (final_refund_received||0) - (service_fee||0)
  };
}

async function deleteTaxBatch(env, id) {
  // 解除關聯花費的批次綁定
  await env.DB.prepare(
    "UPDATE expenses SET refund_status='pending', refund_batch_id=0 WHERE refund_batch_id=?"
  ).bind(id).run();
  await env.DB.prepare("DELETE FROM tax_refund_batches WHERE id=?").bind(id).run();
  return { deleted: id };
}

async function toggleExpenseBatch(env, body) {
  // 從批次中加入/移除單筆花費
  const { expense_id, batch_id, include } = body;
  if (include) {
    await env.DB.prepare(
      "UPDATE expenses SET refund_batch_id=?, refund_status='pending' WHERE id=?"
    ).bind(batch_id, expense_id).run();
  } else {
    await env.DB.prepare(
      "UPDATE expenses SET refund_batch_id=0, refund_status='pending' WHERE id=?"
    ).bind(expense_id).run();
  }
  return { updated: expense_id };
}
async function toggleExpenseBatchWithSync(env, body) {
  const { expense_id, batch_id, include } = body;
  const current = await getExpenseById(env, expense_id);
  const prevBatchId = Number(current?.refund_batch_id || 0);

  if (include) {
    await env.DB.prepare(
      "UPDATE expenses SET refund_batch_id=?, refund_status='pending' WHERE id=?"
    ).bind(batch_id, expense_id).run();
    if (batch_id) await recalcTaxBatch(env, batch_id);
  } else {
    await env.DB.prepare(
      "UPDATE expenses SET refund_batch_id=0, refund_status='pending' WHERE id=?"
    ).bind(expense_id).run();
    if (prevBatchId) await recalcTaxBatch(env, prevBatchId);
  }
  return { updated: expense_id };
}
async function updateExpenseRefundWithSync(env, body) {
  const { id, refund_status, refund_batch_id, shop_group } = body;
  const current = await getExpenseById(env, id);
  if (!current) return { updated: id };

  const prevBatchId = Number(current.refund_batch_id || 0);
  const nextBatchId = Number(refund_batch_id || 0);
  await env.DB.prepare(
    "UPDATE expenses SET refund_status=?, refund_batch_id=?, shop_group=? WHERE id=?"
  ).bind(refund_status || "none", nextBatchId, shop_group || "", id).run();

  if (prevBatchId && prevBatchId !== nextBatchId) await recalcTaxBatch(env, prevBatchId);
  if (nextBatchId) await recalcTaxBatch(env, nextBatchId);
  return { updated: id };
}
async function deleteExpenseWithSync(env, id) {
  const current = await getExpenseById(env, id);
  const batchId = Number(current?.refund_batch_id || 0);
  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  if (batchId) await recalcTaxBatch(env, batchId);
  return { deleted: id };
}

async function updateExpenseWithSync(env, body) {
  const current = await getExpenseById(env, body.id);
  if (!current) return { updated: body.id };

  const { id, name, amount, category, expense_date, note, payment_method,
          tax_type, refund_status, refund_batch_id, shop_group } = body;
  const effectiveTaxType = tax_type || "none";
  const prevBatchId = Number(current.refund_batch_id || 0);
  const nextBatchId = effectiveTaxType === "none"
    ? 0
    : Number(refund_batch_id != null ? refund_batch_id : current.refund_batch_id || 0);
  const effectiveRefStatus = effectiveTaxType !== "none"
    ? (refund_status || current.refund_status || (nextBatchId ? "completed" : "pending"))
    : "none";

  await env.DB.prepare(
    `UPDATE expenses SET
       name=?, amount=?, category=?, expense_date=?,
       note=?, payment_method=?, tax_type=?, refund_status=?, refund_batch_id=?, shop_group=?
     WHERE id=?`
  ).bind(
    name, amount,
    category || "其他",
    expense_date || "",
    note || "",
    payment_method || "現金",
    effectiveTaxType,
    effectiveRefStatus,
    nextBatchId,
    shop_group || "",
    id
  ).run();

  if (prevBatchId && prevBatchId !== nextBatchId) await recalcTaxBatch(env, prevBatchId);
  if (nextBatchId) await recalcTaxBatch(env, nextBatchId);
  return { updated: id };
}

// ═══════════════════════════════════════════
//  MY RESTAURANTS
// ═══════════════════════════════════════════
async function getMyRestaurants(env, member) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM my_restaurants WHERE member = ? ORDER BY id ASC"
  ).bind(member).all();
  return results;
}

async function addMyRestaurant(env, member, body) {
  const { name, area, type, price_range, map_url, note, device_date } = body;
  const existing = await env.DB.prepare(
    "SELECT * FROM my_restaurants WHERE member=? AND name=?"
  ).bind(member, name).first();
  if (existing) {
    await autoAddToSubSchedule(env, member, {
      id: existing.id,
      name: existing.name,
      area: existing.area || area || "",
      map_url: existing.map_url || map_url || "",
      note: existing.note || note || "",
      source_type: "restaurant",
    }, device_date);
    return { id: existing.id, duplicate: true };
  }
  const res = await env.DB.prepare(
    `INSERT INTO my_restaurants (member,name,area,type,price_range,map_url,note)
     VALUES (?,?,?,?,?,?,?) RETURNING id`
  ).bind(member, name, area||"", type||"", price_range||"", map_url||"", note||"").first();

  // 自動加到今天對應主行程的子行程
  await autoAddToSubSchedule(env, member, { id: res.id, name, area, map_url, note, source_type: "restaurant" }, device_date);
  return { id: res.id };
}

async function deleteMyRestaurant(env, member, id) {
  const sourceId = Number(id) || 0;
  if (!sourceId) return { deleted: 0 };

  await env.DB.prepare("DELETE FROM my_restaurants WHERE id=?").bind(sourceId).run();
  await env.DB.prepare(
    "DELETE FROM sub_schedules WHERE member=? AND source_type='restaurant' AND source_id=?"
  ).bind(member, sourceId).run();
  return { deleted: sourceId };
}

// ═══════════════════════════════════════════
//  MY SPOTS
// ═══════════════════════════════════════════
async function getMySpots(env, member) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM my_spots WHERE member = ? ORDER BY id ASC"
  ).bind(member).all();
  return results;
}

async function addMySpot(env, member, body) {
  const { name, area, type, map_url, note, device_date } = body;
  const existing = await env.DB.prepare(
    "SELECT * FROM my_spots WHERE member=? AND name=?"
  ).bind(member, name).first();
  if (existing) {
    await autoAddToSubSchedule(env, member, {
      id: existing.id,
      name: existing.name,
      area: existing.area || area || "",
      map_url: existing.map_url || map_url || "",
      note: existing.note || note || "",
      type: existing.type || type || "景點",
      source_type: "spot",
    }, device_date);
    return { id: existing.id, duplicate: true };
  }
  const res = await env.DB.prepare(
    `INSERT INTO my_spots (member,name,area,type,map_url,note)
     VALUES (?,?,?,?,?,?) RETURNING id`
  ).bind(member, name, area||"", type||"景點", map_url||"", note||"").first();

  // 自動加到今天對應主行程的子行程
  await autoAddToSubSchedule(env, member, { id: res.id, name, area, map_url, note, type, source_type: "spot" }, device_date);
  return { id: res.id };
}

async function deleteMySpot(env, member, id) {
  const sourceId = Number(id) || 0;
  if (!sourceId) return { deleted: 0 };

  await env.DB.prepare("DELETE FROM my_spots WHERE id=?").bind(sourceId).run();
  await env.DB.prepare(
    "DELETE FROM sub_schedules WHERE member=? AND source_type='spot' AND source_id=?"
  ).bind(member, sourceId).run();
  return { deleted: sourceId };
}

async function pruneOrphanPersonalSubSchedules(env, member) {
  const { results } = await env.DB.prepare(
    `SELECT id, source_type, source_id
     FROM sub_schedules
     WHERE member=?
       AND source_type IN ('restaurant', 'spot')
       AND source_id > 0`
  ).bind(member).all();

  const deletions = [];
  for (const row of results || []) {
    const sourceId = Number(row.source_id) || 0;
    if (!sourceId) continue;

    if (row.source_type === "restaurant") {
      const exists = await env.DB.prepare(
        "SELECT 1 FROM my_restaurants WHERE member=? AND id=?"
      ).bind(member, sourceId).first();
      if (!exists) deletions.push(env.DB.prepare("DELETE FROM sub_schedules WHERE id=?").bind(row.id));
    }

    if (row.source_type === "spot") {
      const exists = await env.DB.prepare(
        "SELECT 1 FROM my_spots WHERE member=? AND id=?"
      ).bind(member, sourceId).first();
      if (!exists) deletions.push(env.DB.prepare("DELETE FROM sub_schedules WHERE id=?").bind(row.id));
    }
  }

  if (deletions.length) {
    await env.DB.batch(deletions);
  }
}

function normalizeAreaText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function areaMatches(left, right) {
  const a = normalizeAreaText(left);
  const b = normalizeAreaText(right);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  for (let size = Math.min(4, short.length); size >= 2; size--) {
    for (let i = 0; i <= short.length - size; i++) {
      if (long.includes(short.slice(i, i + size))) return true;
    }
  }
  return false;
}
function getServerYmd(now = new Date()) {
  return now.toLocaleDateString("sv-SE");
}

function normalizeYmd(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

// ── 自動比對 allow_sub 節點，優先加入今天起算的主行程節點 ──
async function autoAddToSubSchedule(env, member, item, deviceDate = "") {
  const area = item.area || "";
  const name = item.name || "";
  if (!area && !name) return;

  const { results: candidates } = await env.DB.prepare(
    "SELECT * FROM schedule WHERE allow_sub = 1 ORDER BY day ASC, time ASC"
  ).all();

  if (!candidates.length) return;

  // 優先使用前端傳來的裝置日期；舊版前端未傳時才回退到後端時間。
  const today = normalizeYmd(deviceDate) || getServerYmd();
  const upcomingCandidates = candidates.filter(s => {
    if (!s.date) return false;
    return String(s.date) >= today;
  });

  if (!upcomingCandidates.length) return;

  const matched =
    upcomingCandidates.find(s => s.location && areaMatches(s.location, area)) ||
    (name ? upcomingCandidates.find(s => s.title && areaMatches(s.title, name)) : null);
  if (!matched) return;

  await addSubSchedule(env, member, {
    schedule_id: matched.id,
    name: item.name,
    type: item.source_type === "restaurant" ? "餐廳" : (item.type || "景點"),
    map_url: item.map_url || "",
    note: item.note || "",
    source_type: item.source_type,
    source_id: item.id,
  });
}
async function getSubSchedules(env, member) {
  await pruneOrphanPersonalSubSchedules(env, member);
  const { results } = await env.DB.prepare(
    "SELECT * FROM sub_schedules WHERE member = ? ORDER BY schedule_id ASC, sort_order ASC, id ASC"
  ).bind(member).all();
  return results;
}

async function addSubSchedule(env, member, body) {
  const { schedule_id, name, type, map_url, note, source_type, source_id } = body;
  // 防重複：同一主行程下同名不重複新增
  const existing = await env.DB.prepare(
    "SELECT id FROM sub_schedules WHERE member=? AND schedule_id=? AND name=?"
  ).bind(member, schedule_id, name).first();
  if (existing) return { id: existing.id, duplicate: true };

  // sort_order 設為當前最大值 + 1
  const maxRow = await env.DB.prepare(
    "SELECT MAX(sort_order) as mx FROM sub_schedules WHERE member=? AND schedule_id=?"
  ).bind(member, schedule_id).first();
  const nextOrder = (maxRow?.mx ?? -1) + 1;

  const res = await env.DB.prepare(
    `INSERT INTO sub_schedules
       (member,schedule_id,name,type,map_url,note,sort_order,source_type,source_id)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`
  ).bind(
    member, schedule_id, name,
    type || "景點", map_url || "", note || "",
    nextOrder, source_type || "", source_id || 0
  ).first();
  return { id: res.id, sort_order: nextOrder };
}

async function deleteSubSchedule(env, id) {
  await env.DB.prepare("DELETE FROM sub_schedules WHERE id=?").bind(id).run();
  return { deleted: id };
}

// 批次更新排序（items = [{id, sort_order}]）
async function reorderSubSchedules(env, items) {
  if (!items?.length) return { updated: 0 };
  const stmt = env.DB.prepare("UPDATE sub_schedules SET sort_order=? WHERE id=?");
  await env.DB.batch(items.map(i => stmt.bind(i.sort_order, i.id)));
  return { updated: items.length };
}

// ═══════════════════════════════════════════
//  PACKING
// ═══════════════════════════════════════════
async function getPacking(env, member) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM packing WHERE member=? ORDER BY id ASC"
  ).bind(member).all();
  if (results.length === 0) {
    await seedPackingList(env, member);
    const { results: r2 } = await env.DB.prepare(
      "SELECT * FROM packing WHERE member=? ORDER BY id ASC"
    ).bind(member).all();
    return r2;
  }
  return results;
}

async function seedPackingList(env, member) {
  const defaults = [
    "護照","日幣","信用卡","西瓜卡",
    "備份藥品","充電器","換洗衣物","盥洗用品"
  ];
  const stmt = env.DB.prepare("INSERT INTO packing (member,item,checked) VALUES (?,?,0)");
  await env.DB.batch(defaults.map(i => stmt.bind(member, i)));
}

async function addPackingItem(env, member, body) {
  const res = await env.DB.prepare(
    "INSERT INTO packing (member,item,checked) VALUES (?,?,0) RETURNING id"
  ).bind(member, body.item).first();
  return { id: res.id };
}

async function togglePacking(env, id, checked) {
  await env.DB.prepare("UPDATE packing SET checked=? WHERE id=?").bind(checked?1:0, id).run();
  return { id, checked };
}

// ═══════════════════════════════════════════
//  ADMIN SEED
// ═══════════════════════════════════════════
async function seedMasterData(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM schedule"),
    env.DB.prepare("DELETE FROM master_restaurants"),
    env.DB.prepare("DELETE FROM master_spots"),
  ]);

const scheduleData = [
  // D1 | 6/4 (四) 下町風情初體驗
  [1, "2026-06-04", "15:20 - 16:30", "入境、領行李、購買交通卡", "", "交通", "成田機場", "https://maps.app.goo.gl/71RhsAwPvfBhpT4z7?g_st=ic", 0],
  [1, "2026-06-04", "16:30 - 17:15", "搭乘 Skyliner 至京城上野站", "約 43分鐘", "交通", "京城上野站", "", 0],
  [1, "2026-06-04", "17:30 - 18:00", "飯店 Check-in 放置行李", "Tosei Hotel Cocone Ueno Okachimachi", "住宿", "Tosei Hotel Cocone Ueno Okachimachi", "https://maps.app.goo.gl/Wkad4N8HbuyNnUAn7?g_st=ic", 0],
  [1, "2026-06-04", "18:30 - 20:00", "阿美橫丁 (Ameyoko)", "體驗熱鬧居酒屋 culture，在此享用晚餐。", "景點", "阿美橫町", "https://maps.app.goo.gl/RhjoAZKz8io2JDW69?g_st=ic", 1],
  [1, "2026-06-04", "20:30 - 21:30", "淺草寺雷門", "夜間點燈漫步，此時遊客較少，適合拍照。", "景點", "淺草寺雷門", "https://maps.app.goo.gl/AnqT3DV4p7sWx1Ch7?g_st=ic", 0],

  // D2 | 6/5 (五) 築地海鮮、時尚銀座與經典鐵塔
  [2, "2026-06-05", "09:00 - 11:00", "築地場外市場", "享用海鮮丼、玉子燒（早午餐）。", "餐飲", "築地市場", "https://maps.app.goo.gl/1LjhYRtz9CeQcCtQ6?g_st=ic", 1],
  [2, "2026-06-05", "11:30 - 15:30", "銀座 (Ginza)", "逛精品店、Uniqlo 旗艦店，享用精緻下午茶。", "景點", "銀座", "https://maps.app.goo.gl/8aoNi6GAbcigseze7?g_st=ic", 1],
  [2, "2026-06-05", "16:00 - 18:00", "東京鐵塔 (Tokyo Tower)", "抵達芝公園拍鐵塔夕陽。", "景點", "東京鐵塔", "https://maps.app.goo.gl/LUUcuYmHv3tSEvwLA?g_st=ic", 0],
  [2, "2026-06-05", "18:30 - 19:30", "觀光巴士行程", "搭乘 Sky Bus 繞行鐵塔至彩虹大橋看夜景。觀光巴士沒搭到可以去六本木。", "景點", "東京鐵塔", "", 0],
  [2, "2026-06-05", "20:00 - 21:30", "飯店附近享用晚餐", "", "餐飲", "阿美橫町", "https://maps.app.goo.gl/RhjoAZKz8io2JDW69?g_st=ic", 0],

  // D3 | 6/6 (六) 潮流尖端：澀谷、表參道、新宿
  [3, "2026-06-06", "09:00 - 11:30", "表參道", "早午餐、逛街", "景點", "表參道", "https://maps.app.goo.gl/zxSE3mfxzPpgytFQ6?g_st=ic", 1],
  [3, "2026-06-06", "11:40 - 12:40", "明治神宮", "感受森林靈氣與建築設計之美。", "景點", "明治神宮", "https://maps.app.goo.gl/zCyW2hx26CSQ7rQP7?g_st=ic", 0],
  [3, "2026-06-06", "13:00 - 18:30", "澀谷", "逛宮下公園、澀谷 109、SHIBUYA SKY。", "景點", "澀谷", "https://maps.app.goo.gl/PwShcTPbXtEbFyY37?g_st=ic", 1],
  [3, "2026-06-06", "19:00 - 21:30", "新宿", "看 3D 貓咪大樓、體驗不夜城氛圍、歌舞伎町與晚餐。", "景點", "新宿", "https://maps.app.goo.gl/4wnCEchphxuEWre98?g_st=ic", 1],

  // D4 | 6/7 (日) 水岸觀光與台場購物
  [4, "2026-06-07", "09:00 - 11:00", "淺草寺", "正式參拜、仲見世通買御守與伴手禮。", "景點", "淺草寺", "https://maps.app.goo.gl/AnqT3DV4p7sWx1Ch7?g_st=ic", 0],
  [4, "2026-06-07", "11:20 - 12:20", "觀光船 (HOTALUNA)", "從淺草搭船直達台場，沿途欣賞隅田川風景，須先至官網查看航班。", "交通", "淺草", "", 0],
  [4, "2026-06-07", "12:30 - 18:30", "台場 (Odaiba)", "DiverCity 看鋼彈、購物中心 Outlet 掃貨。", "景點", "台場", "https://maps.app.goo.gl/mRaWswZFxTXhapce6?g_st=ic", 1],
  [4, "2026-06-07", "18:40 - 19:30", "台場海濱公園", "看彩虹大橋與自由女神像夜景。", "景點", "台場海濱公園", "https://maps.app.goo.gl/exzry5qh5h2LnXby8?g_st=ic", 0],

  // D5 | 6/8 (一) 愜意早晨與機場免稅掃貨
  [5, "2026-06-08", "08:30 - 09:30", "在地喫茶店", "飯店附近享用道地早餐。", "餐飲", "阿美橫町", "", 0],
  [5, "2026-06-08", "09:30 - 11:30", "上野最後補貨", "阿美橫丁藥妝、伴手禮補齊遺漏清單。", "景點", "阿美橫町", "https://maps.app.goo.gl/RhjoAZKz8io2JDW69?g_st=ic", 0],
  [5, "2026-06-08", "11:30 - 12:15", "搭乘 Skyliner 前往成田機場", "", "交通", "京城上野站", "https://maps.app.goo.gl/uAuCxwKEN8MgFyGHA?g_st=ic", 0],
  [5, "2026-06-08", "12:30 - 15:00", "成田機場免稅店", "Fa-So-La 免稅店買伴手禮。", "景點", "成田機場", "", 0],
  [5, "2026-06-08", "16:50", "登機返家", "帶著美好回憶返家。", "交通", "成田機場", "", 0]
];
  const normalizedScheduleData = scheduleData.map((row) =>
    row.length >= 10 ? [...row] : [...row, ""]
  );
  const ss = env.DB.prepare(
    "INSERT INTO schedule (day,date,time,title,note,category,location,map_url,allow_sub,google_maps_list_url) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  await env.DB.batch(normalizedScheduleData.map((row) => ss.bind(...row)));

  // 餐廳依照東京景點區域分類（area 對應景點區域）
  // 欄位：name,area,type,price_range,map_url,feature(逗號分隔多筆),hours,note,recommend
const restData = [
  ["肉之大山", "阿美橫町", "餐廳/小吃", "¥1000", "https://maps.app.goo.gl/T41NYw3GN3tdHfyx6?g_st=ic", "炸肉餅,可樂餅,串燒", "11:00-23:00", "招牌炸肉餅人氣極高", ""],
  ["百果園", "阿美橫町", "小吃/水果", "¥1000", "https://maps.app.goo.gl/jdQVk21qbVJLvnbh7?g_st=ic", "新鮮水果,現切水果串", "10:00-19:00", "上野第一店", ""],
  ["Maguro人", "阿美橫町", "餐廳/壽司", "¥2000-¥3000", "https://maps.app.goo.gl/YFwLL54NjcPtCv217?g_st=ic", "立吞壽司,鮪魚", "11:30-22:00", "御徒町出張所", ""],
  ["立飲KADOKURA", "阿美橫町", "餐廳/立吞", "¥1000-¥2000", "https://maps.app.goo.gl/2rBRj51fduFhLQSE9?g_st=ic", "炸火腿排,豚平燒", "11:00-23:00", "", ""],
  ["茶之君野園", "阿美橫町", "小吃/甜點", "", "https://maps.app.goo.gl/163vsRAJUf1WE1QKA?g_st=ic", "日本茶,抹茶霜淇淋", "10:00-18:30", "", ""],
  ["とんかつ山家 上野店", "阿美橫町", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/dx3TKBBRv5zKYQ958?g_st=ic", "炸豬排", "11:00-15:00 17:00-21:00", "", ""],
  ["名代 宇奈とと 上野店", "阿美橫町", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/SgNRFqKnwNzEvZUa9?g_st=ic", "平價鰻魚飯", "10:00-23:00", "全東京最便宜鰻魚飯", ""],
  ["鐵火丼", "阿美橫町", "餐廳/丼飯", "¥1000", "https://maps.app.goo.gl/qjrzjb2wUmRd5zyx9?g_st=ic", "便宜生魚片丼", "11:00-19:00", "", ""],
  ["大章魚燒みなとや", "阿美橫町", "小吃", "¥1000", "https://maps.app.goo.gl/Y6imvxHywFDVtJtz7?g_st=ic", "巨無霸章魚燒", "11:00-19:00", "", ""],
  ["壽司三味本店", "築地市場", "餐廳/壽司", "¥2000-¥6000", "https://maps.app.goo.gl/V2z2Kkqrt8tnKvQu8?g_st=ic", "24小時,連鎖壽司", "24小時", "", ""],
  ["狐狸屋牛丼", "築地市場", "餐廳/小吃", "¥1000", "https://maps.app.goo.gl/JgiStTqSNi5GrVu88?g_st=ic", "鹹甜牛丼", "6:30-13:00 週日休", "", ""],
  ["山長玉子燒", "築地市場", "小吃", "¥1000", "https://maps.app.goo.gl/RMM9JcaNA4uuyjuu8?g_st=ic", "熱門玉子燒,排隊名店", "6:50-14:30", "", ""],
  ["黑銀鮪屋 まぐろや黑銀", "築地市場", "餐廳/小吃", "¥2000-¥4000", "https://maps.app.goo.gl/QKx6T99TPjD18btr7?g_st=ic", "生魚片,海鮮蓋飯,壽司", "08:00-13:00", "", ""],
  ["江之島丸燒", "築地市場", "小吃", "", "", "丸燒仙貝,海鮮現壓", "09:00-18:00", "東京都中央區築地4-13-10", ""],
  ["築地壽司一番", "築地市場", "餐廳/壽司", "¥2000-¥7000", "https://maps.app.goo.gl/Gzx2pHSTvGyR79sx6?g_st=ic", "24小時,連鎖壽司", "", "", ""],
  ["おにぎり屋 丸豐", "築地市場", "小吃", "¥1000", "https://maps.app.goo.gl/No5NHVweq7GUayao6?g_st=ic", "日式飯糰", "07:00-13:00 週日休", "", ""],
  ["築地コロッケ", "築地市場", "小吃", "¥1000", "https://maps.app.goo.gl/5PJMS2fpqsu1JxdV9?g_st=ic", "可樂餅", "08:00-15:00", "", ""],
  ["築地そらつき", "築地市場", "小吃/甜點", "¥1000", "https://maps.app.goo.gl/sCFAXULDpRPvE7cm7?g_st=ic", "草莓大福", "07:00-15:00", "", ""],
  ["築地さのきや", "築地市場", "小吃/甜點", "", "https://maps.app.goo.gl/2BiSrpS3BKrHGnA37?g_st=ic", "鮪魚燒,鯛魚燒風味", "08:00-15:00 週日休", "", ""],
  ["築地牛武", "築地市場", "小吃", "¥2000-¥3000", "https://maps.app.goo.gl/vE1x8ZvSPjAKy8Ai6?g_st=ic", "炭火現烤,和牛串", "06:30-15:00", "", ""],
  ["海鮮丼 築地丼飯市場", "築地市場", "餐廳/丼飯", "¥1000-¥2000", "https://maps.app.goo.gl/GQ3wPHFX8ms6VZ6G7?g_st=ic", "鮪魚臉頰肉丼", "08:00-14:00", "", ""],
  ["築地うに虎", "築地市場", "餐廳/丼飯", "¥10000up", "https://maps.app.goo.gl/HdhTQ5FCSQXuKWaq5?g_st=ic", "皇帝海膽丼", "07:00-23:00", "", ""],
  ["MATCHA STAND MARUNI", "築地市場", "咖啡廳/甜點", "¥1000", "https://maps.app.goo.gl/RcjRpTQYU6bRoXP67?g_st=ic", "抹茶專賣,現刷抹茶", "08:00-15:00", "", ""],
  ["銀座木村家總本店", "銀座", "餐廳/甜點", "¥1000-¥2000", "https://maps.app.goo.gl/5Zaf6pa9FRg9NKoY9?g_st=ic", "酒種麵包,紅豆麵包", "10:00-20:00", "二樓咖啡廳/三樓洋食", ""],
  ["梅之花 銀座並木通店", "銀座", "餐廳/懷石", "¥3000-¥8000", "https://maps.app.goo.gl/g5H527YBC958LPRi7?g_st=ic", "豆皮豆腐料理,創作懷石", "11:00-16:00 17:00-22:00", "", ""],
  ["花山烏龍麵銀座店", "銀座", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/CEEGsqWaz73f1F9R9?g_st=ic", "寬烏龍麵,排隊名店", "11:00-15:30 17:30-21:30", "", ""],
  ["銀座 天國", "銀座", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/Lx54HkGXmiGWWvv16?g_st=ic", "傳統天婦羅", "11:30-22:00 週日休", "", ""],
  ["挽肉屋 神徳", "銀座", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/FXHKYYewgUaDnxbFA?g_st=ic", "漢堡排,炭烤肉餅", "11:30-21:00", "", ""],
  ["銀座Akebono 銀座本店", "銀座", "小吃/甜點", "", "https://maps.app.goo.gl/4rmmbH2zegT2k9rP7?g_st=ic", "大福,傳統和菓子", "10:00-21:00", "", ""],
  ["燒肉 WASHINO 新宿本店", "新宿", "餐廳", "¥10000up", "https://maps.app.goo.gl/KnBFudQhXFUHgQZ58?g_st=ic", "頂級和牛燒肉", "17:00-23:00", "", ""],
  ["RAKERU 新宿西口店", "新宿", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/JEniAYvFVDSqnnh38?g_st=ic", "60年歷史,蛋包飯", "11:00-21:30", "", ""],
  ["UMI BAL", "新宿", "餐廳", "¥1000-¥6000", "https://maps.app.goo.gl/kGTcMr7BUnSGgx5t6?g_st=ic", "生牡蠣,海鮮義大利麵", "11:30-23:00", "", ""],
  ["now on Cheese♪", "新宿", "小吃/甜點", "", "https://maps.app.goo.gl/L9MFwmp4qxRHKjGQ6?g_st=ic", "起司夾心,起司餅乾", "11:00-21:00", "", ""],
  ["noix de beurre", "新宿", "小吃/甜點", "", "https://maps.app.goo.gl/77GBpfNGVxa57pE57?g_st=ic", "現烤費南雪,瑪德蓮", "10:00-20:00", "", ""],
  ["All Seasons Coffee", "新宿", "咖啡廳", "¥1000-¥2000", "https://maps.app.goo.gl/txPmVGhdSW2qxVpn9?g_st=ic", "必點布丁,手工咖啡", "9:00-19:00", "", ""],
  ["燒肉亭 六歌仙", "新宿", "餐廳", "¥10000up", "https://maps.app.goo.gl/9E68iHpKj4NmQehj9?g_st=ic", "燒肉火鍋吃到飽,和牛", "11:00-23:00", "", ""],
  ["Negishi 牛舌專賣店", "新宿", "餐廳", "¥2000-¥3000", "https://maps.app.goo.gl/yLyTyUhwFcPCyvGGA?g_st=ic", "牛舌飯,山藥泥", "11:00-22:00", "", ""],
  ["新宿思出橫丁 (餐飲區)", "新宿", "景點/小吃街", "", "https://maps.app.goo.gl/g18dc5Tvg5Ds31BE8?g_st=ic", "串燒,居酒屋", "24小時", "包含約80間店鋪", ""],
  ["麵屋武藏・武骨外傳", "澀谷", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/PqxFiCh59twp7NGL9?g_st=ic", "沾麵", "11:30-22:30", "", ""],
  ["燒肉 牛宮城", "澀谷", "餐廳", "¥10000up", "https://maps.app.goo.gl/dc3cRdgHbCpfDxef8?g_st=ic", "燒肉", "11:30-22:30", "", ""],
  ["名曲喫茶LION", "澀谷", "咖啡廳", "¥1000", "https://maps.app.goo.gl/TVnkxUJtTW42GUiz7?g_st=ic", "老字號,音樂咖啡廳", "13:00-20:00", "", ""],
  ["TsuruTonTan UDON", "澀谷", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/ha9Y4MiNQuXRFM8s9?g_st=ic", "烏龍麵", "11:00-23:00", "", ""],
  ["Ryan 雷庵", "澀谷", "餐廳", "", "https://maps.app.goo.gl/6co7byhTTUgcrXUE8?g_st=ic", "定食,生食,酒", "11:30-21:30", "", ""],
  ["豆虎 青山焙煎所", "澀谷", "咖啡廳/甜點", "", "https://maps.app.goo.gl/7gs7cCyCJeLC4Grd7?g_st=ic", "冰品,焙茶", "10:00-20:00", "", ""],
  ["Kenyan Shibuya", "澀谷", "餐廳/咖啡廳", "", "https://maps.app.goo.gl/yotUhZctwE1HiMMZ8?g_st=ic", "東京必喝奶茶", "11:30-22:00", "", ""],
  ["EDW yellow Shibuya", "澀谷", "餐廳", "¥2000-¥3000", "https://maps.app.goo.gl/12DGa2NpDic8BHcT6?g_st=ic", "蛋包飯", "11:00-21:00", "", ""],
  ["Au Temps Jadis", "澀谷", "餐廳/甜點", "", "https://maps.app.goo.gl/a6cemVcFyaWcq1bZ7?g_st=ic", "國王餅", "11:30-19:00", "", ""],
  ["BASO OMOTESANDO", "表參道", "餐廳", "¥1000-¥2000", "https://maps.app.goo.gl/LRHGB7asvw89kPnRA?g_st=ic", "鴨肉蕎麥麵", "11:30-21:00", "", ""],
  ["INITIAL Omotesando", "表參道", "甜點店", "¥2000-¥3000", "https://maps.app.goo.gl/yW4QD8NiXDstiFUT6?g_st=ic", "創意聖代,甜點", "12:00-22:00", "", ""],
  ["Afternoon Tea • LOVE & TABLE", "表參道", "餐廳/甜點", "¥1000-¥2000", "https://maps.app.goo.gl/5S3kWusZ99PjTjGQ6?g_st=ic", "水果千層蛋糕", "10:00-19:00", "", ""],
  ["AMAM DACOTAN 表參道", "表參道", "烘焙坊", "¥1000-¥2000", "https://maps.app.goo.gl/aqdXRaMpGXpYyW2q9?g_st=ic", "網紅麵包店,創意烘焙", "11:00-19:00", "", ""],
  ["yellow 表參道", "表參道", "餐廳", "¥2000-¥3000", "https://maps.app.goo.gl/AcXY7jp2fgepDJF27?g_st=ic", "蛋包飯", "11:00-22:00", "", ""],
  ["i2 cafe", "表參道", "餐廳/咖啡廳", "¥1000-¥2000", "https://maps.app.goo.gl/sH5iAY1hiJ7HoXHo6?g_st=ic", "早午餐,沙拉,咖啡", "8:00-18:00", "", ""],
  ["I'm donut? Omotesando", "表參道", "小吃/甜點", "¥1000", "https://maps.app.goo.gl/m1QTqEsLYucQpncPA?g_st=ic", "生甜甜圈,排隊名店", "10:00-20:00", "", ""],
  ["漢堡排 嘉", "表參道", "餐廳", "¥2000-¥3000", "https://maps.app.goo.gl/zDdxeP5sYBiZoTiq6?g_st=ic", "炭火漢堡排", "", "", ""],
  ["Gyu Star 牛スター 上野", "阿美橫町", "燒肉", "¥1000-¥2000", "https://maps.app.goo.gl/GuCX7Qw4B8K5uSia8?g_st=ic", "便宜燒肉", "11:00-15:00 17:00-23:00", "", ""]
];
  const rs = env.DB.prepare("INSERT INTO master_restaurants (name,area,type,price_range,map_url,feature,hours,note,recommend) VALUES (?,?,?,?,?,?,?,?,?)");
  await env.DB.batch(restData.map(r => rs.bind(...r)));

  // 欄位：name,area,type,cost,map_url,feature(逗號分隔),suggested_time,hours,note,transport,station,exit,walk_min,transport_map
  const spotData = [
  // 阿美橫町
  ["上野公園", "阿美橫町", "景點", "", "https://maps.app.goo.gl/4nEkhgDKMST77qQ38?g_st=ic", "賞櫻,賞楓,散步勝地", "", "", "知名勝地", "", "", "", 0, ""],
  ["阿美橫中心大樓", "阿美橫町", "地標/購物", "", "https://maps.app.goo.gl/HzfbNo8hoVgZvdEB6?g_st=ic", "街道地標,兩街交匯點", "", "", "位在街道中間", "", "", "", 0, ""],
  ["志村商店", "阿美橫町", "購物/食品", "", "https://maps.app.goo.gl/CTX3Q1sd6Jw5utpC6?g_st=ic", "巧克力叫賣", "", "10:00-17:30", "", "", "", "", 0, ""],
  ["二木菓子", "阿美橫町", "購物/零食", "", "https://maps.app.goo.gl/DmbfdV1Rhdp4X4B37?g_st=ic和BIC館4 https://maps.app.goo.gl/Q5g5y1DDK3ip8FZAA?g_st=ic", "懷舊零食,食玩", "", "10:00-20:00", "伴手禮必買", "", "", "", 0, ""],
  ["唐吉訶德", "阿美橫町", "購物/百貨", "", "https://maps.app.goo.gl/AKtzLryRGGTJdKps7?g_st=ic", "綜合百貨,24小時購物", "", "9:00-01:00", "御徒町店", "", "", "", 0, ""],
  ["小島屋", "阿美橫町", "購物/食品", "", "https://maps.app.goo.gl/dGpLDbd7DX7sLrs37?g_st=ic", "堅果專賣,果乾批發", "", "10:00-18:30", "超過60年歷史", "", "", "", 0, ""],
  ["Sundrug藥妝", "阿美橫町", "購物/藥妝", "", "https://maps.app.goo.gl/PozS5W8Ln77SudbU8?g_st=ic", "連鎖藥妝", "", "09:30-23:00", "鄰近上野站", "", "", "", 0, ""],
  ["OS藥妝", "阿美橫町", "購物/藥妝", "", "https://maps.app.goo.gl/XzKEiH1T2bwDCd6a9?g_st=ic", "連鎖藥妝", "", "10:00-19:45", "上野店", "", "", "", 0, ""],
  ["松本清", "阿美橫町", "購物/藥妝", "", "https://maps.app.goo.gl/k7j8ypZLNwrYTu6S6?g_st=ic、距離JR御徒町站步行約3分鐘的「上野阿美橫Part https://maps.app.goo.gl/2Yt9c8hp6Dki3iQR6?g_st=ic、以及以化妝品種類特別豐富的「上野阿美橫Beauty館」4 https://maps.app.goo.gl/5kEgGSQJB6g4mcdQ7?g_st=ic", "連鎖藥妝,代表性品牌", "", "09:30-23:00", "含Part 1、2店", "", "", "", 0, ""],
  ["SUGI藥局", "阿美橫町", "購物/藥妝", "", "https://maps.app.goo.gl/UpkJMNsDVscXK8ag9?g_st=ic", "大型藥妝連鎖", "", "10:00-23:30", "近御徒町站", "", "", "", 0, ""],
  ["大國藥妝", "阿美橫町", "購物/藥妝", "", "https://maps.app.goo.gl/KLDRVmDCujyNXz9x8?g_st=ic", "連鎖藥妝", "", "09:35-22:50", "近御徒町站", "", "", "", 0, ""],
  ["多慶屋", "阿美橫町", "購物/免稅", "", "https://maps.app.goo.gl/1sydSQRAf6UJu65z7?g_st=ic", "免稅折扣店,多樣商品", "", "10:00-19:00", "", "", "", "", 0, ""],
  ["ABC-MART", "阿美橫町", "購物/鞋類", "", "https://maps.app.goo.gl/ycNJMvF1XLgngDG16?g_st=ic", "連鎖鞋店", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["京和水産", "阿美橫町", "購物/生鮮", "", "https://maps.app.goo.gl/jHub2aWuyhhhk7bh7?g_st=ic", "高CP值生鮮", "", "10:00-19:00", "", "", "", "", 0, ""],
  ["摩利支天德大寺", "阿美橫町", "景點/寺廟", "", "https://maps.app.goo.gl/Dpoqkveu2h3g4e537?g_st=ic", "消災除難,400年歷史", "", "06:30-18:30", "", "", "", "", 0, ""],

  // 銀座
  ["松屋銀座", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/3SZgFjACRJMeUJnP9?g_st=ic", "百貨公司,精品", "", "11:00-20:00", "站點直通", "", "", "", 0, ""],
  ["銀座三越", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/gzEUCFth784BjkYM6?g_st=ic", "百貨公司,老牌精品", "", "10:00-20:00", "", "", "", "", 0, ""],
  ["GINZA SIX", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/N3dFjUKTjRCP1kDCA?g_st=ic", "大型複合百貨,藝術景點", "", "10:30-20:30", "", "", "", "", 0, ""],
  ["日比谷Chanter", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/jhjnykSBR1TDyC3J6?g_st=ic", "百貨公司,服飾零售", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["東京中城日比谷", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/wVNrGTmymA8LZbPy8?g_st=ic", "複合式商場,空中花園", "", "11:00-23:00", "", "", "", "", 0, ""],
  ["無印良品 銀座", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/ykDbxejJtRMwwvzp9?g_st=ic", "全球旗艦店,MUJI酒店", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["銀座伊東屋本店", "銀座", "購物/文具", "", "https://maps.app.goo.gl/zW2bUoRmfhxZACsW6?g_st=ic", "大型文具店,創意商品", "", "10:00-20:00", "", "", "", "", 0, ""],
  ["有樂町丸井百貨", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/tDwSQD6NHc431Xvo6?g_st=ic", "流行服飾,生活百貨", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["LUMINE 有樂町店", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/GHL5zsiZb7FSFXeo7?g_st=ic", "時尚百貨,流行指標", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["和光銀座本館", "銀座", "地標/購物", "", "https://maps.app.goo.gl/54Ebc2zafYPNZCMD8?g_st=ic", "鐘塔地標,高級鐘錶", "", "12:00-19:00", "銀座知名地標", "", "", "", 0, ""],
  ["阪急MEN'S TOKYO", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/3AgDJkLrjing1GrZ9?g_st=ic", "男性專屬百貨", "", "12:00-20:00", "近有樂町站", "", "", "", 0, ""],
  ["歌舞伎座", "銀座", "景點/劇場", "", "https://maps.app.goo.gl/hArXu2EEaZ8YBk9T8?g_st=ic", "歌舞伎表演,傳統文化", "", "", "大型劇場需購票", "", "", "", 0, ""],
  ["濱離宮恩賜庭園", "銀座", "景點/庭園", "", "https://maps.app.goo.gl/PsthMcwyXmcTxFX49?g_st=ic", "江戶庭園,潮入之池", "", "9:00-17:00", "都立庭園", "", "", "", 0, ""],
  ["勝鬨橋", "銀座", "景點/橋樑", "", "https://maps.app.goo.gl/kX677Lou87S4VP8c8?g_st=ic", "景觀橋樑,夜間點燈", "", "24小時", "22:00前有點燈", "", "", "", 0, ""],
  ["Ginza Sony Park", "銀座", "景點/公園", "", "https://maps.app.goo.gl/hb7uZn3hzqSNA8yw8?g_st=ic", "都市公園,概念空間", "", "11:00-19:00", "", "", "", "", 0, ""],
  ["博品館 TOY PARK", "銀座", "購物/玩具", "", "https://maps.app.goo.gl/VRJ6xt9dCNgrnNZs5?g_st=ic", "巨型玩具店,親子景點", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["三麗鷗 銀座店", "銀座", "購物/百貨", "", "https://maps.app.goo.gl/LQdcqXxeKczNMTcp6?g_st=ic", "Sanrio角色,特色精品", "", "11:00-20:00", "位於西銀座", "", "", "", 0, ""],

  // 新宿
  ["歌舞伎町", "新宿", "景點/地標", "", "https://maps.app.goo.gl/QKSp5fNeZfLXcvcx5?g_st=ic。東急歌舞伎町TOWER https://maps.app.goo.gl/sMzLV2VQfnM4vJDV9?g_st=ic", "不夜城,歌舞伎町TOWER", "", "24小時", "含花道東京、東急TOWER", "", "", "", 0, ""],
  ["Lumine est", "新宿", "購物/百貨", "", "https://maps.app.goo.gl/YYdZ2FGTnbTwAHhy7?g_st=ic", "流行服飾,車站連通", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["東京都廳展望室", "新宿", "景點", "", "https://maps.app.goo.gl/6wXXajvau4sYHUmT6?g_st=ic", "免費展望台,南展望台", "", "9:30-22:00", "45樓展望室", "", "", "", 0, ""],
  ["新宿御苑", "新宿", "景點", "", "https://maps.app.goo.gl/sRbRn64bmx4a4FBB9?g_st=ic", "江戶宅邸用地,大型庭園", "", "9:00-18:00", "需購票門票", "", "", "", 0, ""],
  ["新宿黃金街", "新宿", "景點/酒吧區", "", "https://maps.app.goo.gl/2XiGRqevP5an4aoC9?g_st=ic", "復古酒場街", "", "24小時", "位於歌舞伎町旁", "", "", "", 0, ""],
  ["花園神社", "新宿", "景點/寺廟", "", "https://maps.app.goo.gl/ayRer8Lv4jNQMvGeA?g_st=ic", "新宿守護神", "", "24小時", "", "", "", "", 0, ""],
  ["新大久保韓國城", "新宿", "景點/購物", "", "https://maps.google.com?q=Shin-Okubo%20Korea%20Town,%201%20Chome-4-15%20Hyakunincho,%20Shinjuku%20City,%20Tokyo%20169-0073%E6%97%A5%E6%9C%AC&ftid=0x60188d007b012f23:0xe9f0f5251f1b4960&entry=gps&shh=CAE&lucs=,94297699,94284460,94231188,94280568,47071704,94218641,94282134,94286869&g_st=ic", "韓國文化街,韓流美食", "", "24小時", "", "", "", "", 0, ""],
  ["新宿東口の猫", "新宿", "景點", "", "https://maps.app.goo.gl/UoexL65JYh5Lu8rPA?g_st=ic", "3D貓,整點播放", "", "07:00-01:00", "每15分鐘一次", "", "", "", 0, ""],
  ["新宿京王百貨", "新宿", "購物/百貨", "", "https://maps.app.goo.gl/ifcHchFEkLYst3xJ6?g_st=ic", "交通便利,百貨公司", "", "10:00-20:00", "", "", "", "", 0, ""],
  ["Victoria新宿", "新宿", "購物/運動", "", "https://maps.app.goo.gl/s4TRueAGZ1PxTcXWA?g_st=ic", "大型運動用品", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["東京迪士尼旗艦店", "新宿", "購物", "", "https://maps.app.goo.gl/PMuDWhCBoqgXCruw5?g_st=ic", "迪士尼商品,旗艦門市", "", "10:00-21:00", "位於新宿3丁目", "", "", "", 0, ""],
  ["三麗鷗商店", "新宿", "購物", "", "https://maps.app.goo.gl/K9Dzi78khaHyZnv88?g_st=ic", "Hello Kitty,文具精品", "", "11:00-20:00", "紀伊國屋1F名店街", "", "", "", 0, ""],
  ["Newoman", "新宿", "購物/百貨", "", "https://maps.app.goo.gl/Upng8q5cFKV8EQkt9?g_st=ic", "車站附屬商場,精品", "", "11:00-20:30", "", "", "", "", 0, ""],
  ["哥吉拉的頭", "新宿", "景點/地標", "", "https://maps.app.goo.gl/h8W4tZWMTVLtv9397?g_st=ic", "巨大哥吉拉", "", "", "格拉斯麗飯店", "", "", "", 0, ""],
  ["BicCamera 新宿東口店", "新宿", "購物/電器", "", "https://maps.app.goo.gl/TZcwvgSCxTtwzVzB9?g_st=ic", "連鎖電器,免稅購物", "", "10:00-22:00", "", "", "", "", 0, ""],
  ["唐吉訶德 新宿東南口店", "新宿", "購物/百貨", "", "https://maps.app.goo.gl/io4Wd7YqqdFrPZgK9?g_st=ic", "24小時購物,綜合折扣店", "", "24小時", "", "", "", "", 0, ""],

  // 澀谷
  ["澀谷十字路口", "澀谷", "景點/地標", "", "https://maps.app.goo.gl/V87VGDf7X2cRXiZ36?g_st=ic", "世界最大人流交叉口", "", "", "", "", "", "", 0, ""],
  ["澀谷中心街", "澀谷", "景點/購物", "", "https://maps.app.goo.gl/Xk8viZ3JwAbEBhJy5?g_st=ic", "商店街,流行文化", "", "24小時", "", "", "", "", 0, ""],
  ["忠犬八公像", "澀谷", "景點/地標", "", "https://maps.app.goo.gl/7nQcn3g6J6L7ZHzDA?g_st=ic", "會合點,忠犬八公", "", "24小時", "", "", "", "", 0, ""],
  ["宇宙天文台澀谷", "澀谷", "景點", "", "https://maps.app.goo.gl/b71tjXwGQewE2uHV9?g_st=ic", "天文台,星象儀", "", "12:00-20:00", "需門票,位於12樓", "", "", "", 0, ""],
  ["SHIBUYA SKY", "澀谷", "景點", "", "https://maps.app.goo.gl/oFizkjxkC9y2SLD1A?g_st=ic", "展望台,高空景觀", "", "10:00-22:30", "", "", "", "", 0, ""],
  ["澀谷 SCRAMBLE SQUARE", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/JGjNeBZe9oBDKZwv8?g_st=ic", "澀谷最高樓,複合設施", "", "10:00-21:00", "", "", "", "", 0, ""],
  ["宮下公園", "澀谷", "景點/購物", "", "https://maps.app.goo.gl/YJqhQLBZQX4MEue7A?g_st=ic", "屋頂公園,複合設施", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["澀谷飲兵衛橫丁", "澀谷", "景點/居酒屋", "", "https://maps.app.goo.gl/KgD18cNwyrn54A4p9?g_st=ic", "復古橫丁,居酒屋街", "", "17:00-04:00", "週日休", "", "", "", 0, ""],
  ["SHIBUYA109", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/dCJRALV6sTUNpznJA?g_st=ic", "潮流元祖,女裝地標", "", "10:00-21:00", "", "", "", "", 0, ""],
  ["澀谷HIKARIE", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/Z6p6PYxv5gYBsB8f6?g_st=ic", "高層複合設施,藝術", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["澀谷MODI", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/Pfi4oUe3MXUQhHsy5?g_st=ic", "文化傳播據點,流行", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["澀谷東急廣場", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/mmwFKZKPBmCGsCa68?g_st=ic", "百貨,美食街", "", "11:00-20:00", "", "", "", "", 0, ""],
  ["澀谷MARK CITY", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/dFfoNySj74E6WYQo8?g_st=ic", "車站直通,餐飲購物", "", "", "", "", "", "", 0, ""],
  ["UNIQLO 澀谷道玄坂店", "澀谷", "購物", "", "https://maps.app.goo.gl/5ZiC8ExfH2wh7fsT9?g_st=ic", "連鎖服飾", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["澀谷PARCO", "澀谷", "購物/百貨", "", "https://maps.app.goo.gl/mAsRpC1UfUVTdkZc9?g_st=ic", "潮流文化,任天堂中心", "", "11:00-21:00", "", "", "", "", 0, ""],
  ["迪士尼商店 澀谷公園大道店", "澀谷", "購物", "", "https://maps.app.goo.gl/ZMwYbdp4w3sg9Jem7?g_st=ic", "迪士尼精品", "", "11:00-20:00", "", "", "", "", 0, ""],

  // 表參道
  ["手工牛奶糖 NUMBER SUGAR", "表參道", "購物/伴手禮", "", "https://maps.app.goo.gl/Uygd79qrNL4WcVqn9?g_st=ic", "手工牛奶糖,精緻包裝", "", "11:00-19:00", "", "", "", "", 0, ""],
  ["表參道之丘", "表參道", "購物/百貨", "", "https://maps.app.goo.gl/eJ5ACNFNZbq9adZ5A?g_st=ic", "安藤忠雄設計,建築美學", "", "11:00-20:00", "", "", "", "", 0, ""]
];
  const sps = env.DB.prepare("INSERT INTO master_spots (name,area,type,cost,map_url,feature,suggested_time,hours,note,transport,station,exit,walk_min,transport_map) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  await env.DB.batch(spotData.map(r => sps.bind(...r)));

  return { seeded: true, schedule: scheduleData.length, restaurants: restData.length, spots: spotData.length };
}
