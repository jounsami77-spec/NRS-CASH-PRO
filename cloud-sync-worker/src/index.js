const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function fail(message, status = 400) {
  return response({ ok: false, error: message }, status);
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return diff === 0;
}

function validUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

// توحيد ترتيب مفاتيح JSON قبل مقارنة الأحداث المكررة.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }

  if (isObject(value)) {
    return "{" + Object.keys(value).sort().map(
      key => JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }

  return JSON.stringify(value);
}

function validText(value, min = 1, max = 200) {
  return typeof value === "string" &&
    value.trim().length >= min &&
    value.length <= max;
}

function validNumber(value, min = 0, max = 1000000000000) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
}

async function readJson(request, maxBytes = 1024 * 1024) {
  const length = Number(request.headers.get("content-length") || 0);

  if (length > maxBytes) {
    throw new HttpError("حجم الطلب أكبر من المسموح", 413);
  }

  const raw = await request.text();

  if (new TextEncoder().encode(raw).length > maxBytes) {
    throw new HttpError("حجم الطلب أكبر من المسموح", 413);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError("JSON غير صالح", 400);
  }
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_BOOTSTRAP_SECRET) {
    throw new HttpError("سر الإدارة غير مضبوط على الخادم", 503);
  }

  const supplied = bearer(request);
  if (!supplied) return false;

  const a = await sha256(supplied);
  const b = await sha256(env.ADMIN_BOOTSTRAP_SECRET);

  return constantTimeEqual(a, b);
}

async function requireDevice(request, env) {
  const token = bearer(request);
  if (!token) return null;

  const tokenHash = await sha256(token);

  const device = await env.DB.prepare(
    `SELECT id, store_id, name
     FROM devices
     WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(tokenHash).first();

  if (!device) return null;

  await env.DB.prepare(
    `UPDATE devices SET last_seen_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), device.id).run();

  return device;
}

async function createStore(request, env) {
  if (!await requireAdmin(request, env)) {
    return fail("غير مصرح", 401);
  }

  const body = await readJson(request);

  if (!isObject(body)) {
    return fail("بيانات إنشاء المتجر غير صالحة");
  }

  const name = typeof body.store_name === "string"
    ? body.store_name.trim()
    : "";

  if (!validText(name, 2, 120)) {
    return fail("اسم المتجر غير صالح");
  }

  const storeId = crypto.randomUUID();
  const pairingCode = randomToken(24);
  const codeHash = await sha256(pairingCode);
  const now = new Date().toISOString();
  const expires = Date.now() + 15 * 60 * 1000;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stores (id, name, created_at)
       VALUES (?, ?, ?)`
    ).bind(storeId, name, now),

    env.DB.prepare(
      `INSERT INTO pairing_codes
       (code_hash, store_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(codeHash, storeId, expires, now)
  ]);

  return response({
    ok: true,
    store_id: storeId,
    store_name: name,
    pairing_code: pairingCode,
    expires_in_seconds: 900
  }, 201);
}


async function listStoreDevices(request, env, storeId) {
  if (!validUuid(storeId)) {
    return fail("معرف المتجر غير صالح");
  }

  const result = await env.DB.prepare(
    `SELECT id, name, created_at, last_seen_at, revoked_at
     FROM devices
     WHERE store_id = ?
     ORDER BY created_at DESC`
  ).bind(storeId).all();

  return response({
    ok: true,
    store_id: storeId,
    devices: result?.results || []
  });
}

async function revokeStoreDevice(request, env, storeId, deviceId) {
  if (!validUuid(storeId) || !validUuid(deviceId)) {
    return fail("معرف المتجر أو الجهاز غير صالح");
  }

  const revokedAt = new Date().toISOString();

  const result = await env.DB.prepare(
    `UPDATE devices
     SET revoked_at = ?
     WHERE id = ?
       AND store_id = ?
       AND revoked_at IS NULL`
  ).bind(revokedAt, deviceId, storeId).run();

  const changes = Number(result?.meta?.changes || 0);

  if (changes !== 1) {
    return fail("الجهاز غير موجود أو سبق إلغاء ربطه", 404);
  }

  return response({
    ok: true,
    store_id: storeId,
    device_id: deviceId,
    revoked: true,
    revoked_at: revokedAt
  });
}

async function enrollDevice(request, env) {
  const body = await readJson(request);

  if (!isObject(body)) {
    return fail("بيانات ربط الجهاز غير صالحة");
  }

  const code = String(body.pairing_code || "").trim();
  const name = String(body.device_name || "NRS Android").trim();

  if (code.length < 20 || code.length > 100) {
    return fail("رمز الربط غير صالح");
  }

  if (!validText(name, 1, 80)) {
    return fail("اسم الجهاز غير صالح");
  }

  const codeHash = await sha256(code);
  const nowMs = Date.now();

  const pairing = await env.DB.prepare(
    `SELECT store_id FROM pairing_codes
     WHERE code_hash = ?
       AND used_at IS NULL
       AND expires_at > ?`
  ).bind(codeHash, nowMs).first();

  if (!pairing) {
    return fail("رمز الربط منتهي أو مستخدم أو غير صحيح", 401);
  }

  // إنشاء الجهاز واستهلاك الرمز داخل D1 batch واحدة.
  // إذا فشل إدخال الجهاز، تفشل المعاملة ولا يُحرق رمز الربط.
  const deviceId = crypto.randomUUID();
  const deviceToken = randomToken(32);
  const tokenHash = await sha256(deviceToken);
  const now = new Date().toISOString();

  const enrollmentResults = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices
       (id, store_id, name, token_hash, created_at, last_seen_at)
       SELECT ?, store_id, ?, ?, ?, ?
       FROM pairing_codes
       WHERE code_hash = ?
         AND used_at IS NULL
         AND expires_at > ?`
    ).bind(
      deviceId,
      name,
      tokenHash,
      now,
      now,
      codeHash,
      nowMs
    ),

    env.DB.prepare(
      `UPDATE pairing_codes
       SET used_at = ?
       WHERE code_hash = ?
         AND used_at IS NULL
         AND expires_at > ?`
    ).bind(nowMs, codeHash, nowMs)
  ]);

  const inserted = Number(
    enrollmentResults[0]?.meta?.changes || 0
  );
  const consumed = Number(
    enrollmentResults[1]?.meta?.changes || 0
  );

  if (inserted !== 1 || consumed !== 1) {
    return fail("تعذر ربط الجهاز أو أن رمز الربط استُخدم", 409);
  }

  return response({
    ok: true,
    store_id: pairing.store_id,
    device_id: deviceId,
    device_name: name,
    device_token: deviceToken
  }, 201);
}

function validateEvent(event) {
  if (!isObject(event)) return "الحدث غير صالح";

  if (!validUuid(event.event_uuid)) {
    return "event_uuid غير صالح";
  }

  if (!validUuid(event.entity_uuid)) {
    return "entity_uuid غير صالح";
  }

  if (!["product", "sale"].includes(event.entity_type)) {
    return "نوع الكيان غير مدعوم";
  }

  const allowed = {
    product: ["create", "update", "delete", "stock.adjust"],
    sale: ["create", "snapshot"]
  };

  if (!allowed[event.entity_type].includes(event.operation)) {
    return "العملية غير مدعومة";
  }

  const p = event.payload;
  if (!isObject(p)) return "محتوى الحدث غير صالح";

  if (p.sync_uuid !== event.entity_uuid) {
    return "معرف المزامنة لا يطابق معرف الحدث";
  }

  if (event.entity_type === "product") {
    if (event.operation === "create") {
      if (!validText(p.name, 1, 200)) return "اسم المنتج غير صالح";
      if (!validNumber(p.price)) return "سعر المنتج غير صالح";
      if (!validNumber(p.initial_stock)) return "مخزون البداية غير صالح";
      if (p.pack_size !== undefined &&
          !validNumber(p.pack_size, 0.000001)) {
        return "حجم العبوة غير صالح";
      }
    }

    if (event.operation === "update") {
      if (!validText(p.name, 1, 200)) return "اسم المنتج غير صالح";
      if (!validNumber(p.price)) return "سعر المنتج غير صالح";
    }

    if (event.operation === "delete") {
      if (p.local_id !== undefined && !validNumber(p.local_id, 0)) {
        return "معرف المنتج المحلي غير صالح";
      }
    }

    if (event.operation === "stock.adjust") {
      if (typeof p.delta !== "number" ||
          !Number.isFinite(p.delta) ||
          p.delta === 0 ||
          Math.abs(p.delta) > 1000000000) {
        return "قيمة تعديل المخزون غير صالحة";
      }
    }
  }

  if (event.entity_type === "sale") {
    if (!validNumber(p.total)) return "إجمالي الفاتورة غير صالح";

    if (p.created_at !== undefined &&
        (typeof p.created_at !== "string" ||
         p.created_at.trim().length < 1 ||
         p.created_at.length > 80)) {
      return "تاريخ الفاتورة غير صالح";
    }

    if (event.operation === "create") {
      if (!Array.isArray(p.items) ||
          p.items.length < 1 ||
          p.items.length > 200) {
        return "تفاصيل الفاتورة غير صالحة";
      }

      for (const item of p.items) {
        if (!isObject(item)) return "عنصر الفاتورة غير صالح";
        if (!validUuid(item.product_sync_uuid)) {
          return "معرف منتج الفاتورة غير صالح";
        }
        if (!validNumber(item.quantity, 0.000001, 1000000000)) {
          return "كمية البيع غير صالحة";
        }
        if (!validNumber(item.price)) return "سعر عنصر الفاتورة غير صالح";
        if (!validNumber(item.subtotal)) return "مجموع عنصر الفاتورة غير صالح";
      }
    }

    if (event.operation === "snapshot") {
      const statuses = [
        "sold", "exchanged", "returned", "cancelled"
      ];

      if (!statuses.includes(p.status)) {
        return "حالة الفاتورة غير صالحة";
      }

      if (!Array.isArray(p.items) ||
          p.items.length < 1 ||
          p.items.length > 200) {
        return "تفاصيل لقطة الفاتورة غير صالحة";
      }

      const lineIds = new Set();

      for (const item of p.items) {
        if (!isObject(item)) return "عنصر الفاتورة غير صالح";

        if (!validUuid(item.line_sync_uuid)) {
          return "معرف سطر الفاتورة غير صالح";
        }

        if (lineIds.has(item.line_sync_uuid)) {
          return "معرف سطر الفاتورة مكرر";
        }
        lineIds.add(item.line_sync_uuid);

        if (item.product_sync_uuid !== null &&
            !validUuid(item.product_sync_uuid)) {
          return "معرف المنتج المرتبط بالسطر غير صالح";
        }

        if (!validText(item.name, 1, 200)) {
          return "اسم عنصر الفاتورة غير صالح";
        }

        // Backward compatible: older queued events may omit unit.
        if (item.unit !== undefined &&
            (typeof item.unit !== "string" ||
             item.unit.trim().length < 1 ||
             item.unit.length > 40)) {
          return "وحدة قياس عنصر الفاتورة غير صالحة";
        }

        if (!validNumber(item.quantity, 0.000001, 1000000000) ||
            !validNumber(item.base_quantity, 0, 1000000000)) {
          return "كمية عنصر الفاتورة غير صالحة";
        }

        if (!validNumber(item.price) ||
            !validNumber(item.subtotal)) {
          return "سعر أو مجموع عنصر الفاتورة غير صالح";
        }

        if (typeof item.is_cancelled !== "boolean") {
          return "حالة إلغاء عنصر الفاتورة غير صالحة";
        }

        if (item.cancelled_at !== null &&
            item.cancelled_at !== undefined &&
            (typeof item.cancelled_at !== "string" ||
             item.cancelled_at.length > 80)) {
          return "تاريخ إلغاء عنصر الفاتورة غير صالح";
        }
      }

      if (p.customer_name !== undefined &&
          (typeof p.customer_name !== "string" ||
           p.customer_name.length > 120)) {
        return "اسم الزبون غير صالح";
      }

      if (p.customer_phone !== undefined &&
          (typeof p.customer_phone !== "string" ||
           p.customer_phone.length > 40)) {
        return "رقم هاتف الزبون غير صالح";
      }

      if (!Array.isArray(p.stock_deltas) ||
          p.stock_deltas.length > 200) {
        return "فروق المخزون غير صالحة";
      }

      const deltaProducts = new Set();

      for (const change of p.stock_deltas) {
        if (!isObject(change) ||
            !validUuid(change.product_sync_uuid)) {
          return "معرف منتج فرق المخزون غير صالح";
        }

        if (deltaProducts.has(change.product_sync_uuid)) {
          return "يجب تجميع فروق المنتج الواحد في فرق واحد";
        }
        deltaProducts.add(change.product_sync_uuid);

        if (typeof change.delta !== "number" ||
            !Number.isFinite(change.delta) ||
            change.delta === 0 ||
            Math.abs(change.delta) > 1000000000) {
          return "قيمة فرق المخزون غير صالحة";
        }
      }
    }
  }

  if (event.created_at !== undefined &&
      (typeof event.created_at !== "string" ||
       event.created_at.length > 80)) {
    return "تاريخ الحدث غير صالح";
  }

  return null;
}

export { validateEvent, canonicalJson, pushEvents };

async function pushEvents(request, env, device) {
  const body = await readJson(request);

  if (!isObject(body) ||
      !Array.isArray(body.events) ||
      body.events.length < 1 ||
      body.events.length > 100) {
    return fail("أرسل من 1 إلى 100 حدث في كل طلب");
  }

  // المرحلة الأولى: التحقق من جميع الأحداث دون إجراء أي كتابة.
  const prepared = [];
  const requestEvents = new Map();

  for (const event of body.events) {
    const invalid = validateEvent(event);
    if (invalid) return fail(invalid);

    const payloadJson = canonicalJson(event.payload);

    if (new TextEncoder().encode(payloadJson).length > 100000) {
      return fail("حجم الحدث أكبر من المسموح");
    }

    const signature = canonicalJson({
      entity_type: event.entity_type,
      entity_uuid: event.entity_uuid,
      operation: event.operation,
      payload: event.payload,
      created_at: String(event.created_at ?? "")
    });

    // منع استعمال event_uuid نفسه بمحتويين مختلفين داخل الطلب الواحد.
    const previous = requestEvents.get(event.event_uuid);

    if (previous !== undefined && previous !== signature) {
      return fail(
        "تعارض: استُخدم معرف الحدث نفسه بمحتوى مختلف",
        409
      );
    }

    requestEvents.set(event.event_uuid, signature);

    prepared.push({
      event,
      payloadJson
    });
  }

  // المرحلة الثانية: فحص الأحداث المحفوظة قبل إدخال أي حدث جديد.
  for (const { event } of prepared) {
    const existing = await env.DB.prepare(
      `SELECT source_device_id, entity_type, entity_uuid,
              operation, payload_json, client_created_at
       FROM sync_events
       WHERE store_id = ? AND event_uuid = ?`
    ).bind(device.store_id, event.event_uuid).first();

    if (!existing) continue;

    let existingPayload;
    try {
      existingPayload = JSON.parse(existing.payload_json);
    } catch {
      throw new HttpError("حدث محفوظ تالف", 500);
    }

    const sameEvent =
      existing.source_device_id === device.id &&
      existing.entity_type === event.entity_type &&
      existing.entity_uuid === event.entity_uuid &&
      existing.operation === event.operation &&
      canonicalJson(existingPayload) ===
        canonicalJson(event.payload) &&
      existing.client_created_at ===
        String(event.created_at ?? "");

    if (!sameEvent) {
      return fail(
        "تعارض: استُخدم معرف الحدث نفسه بمحتوى مختلف",
        409
      );
    }
  }

  // المرحلة الثالثة: لا نصل إلى الكتابة إلا بعد نجاح جميع الفحوص السابقة.
  const statements = prepared.map(({ event, payloadJson }) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO sync_events
       (store_id, event_uuid, source_device_id, entity_type,
        entity_uuid, operation, payload_json,
        client_created_at, server_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      device.store_id,
      event.event_uuid,
      device.id,
      event.entity_type,
      event.entity_uuid,
      event.operation,
      payloadJson,
      String(event.created_at ?? ""),
      new Date().toISOString()
    )
  );

  let results;

  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    // Trigger داخل D1 يرفض UUID المتعارض داخل المعاملة نفسها.
    if (String(error?.message || error).includes(
      "NRS_EVENT_UUID_CONFLICT"
    )) {
      return fail(
        "تعارض: استُخدم معرف الحدث نفسه بمحتوى مختلف",
        409
      );
    }

    throw error;
  }

  const acknowledgements = prepared.map(({ event }, index) => ({
    event_uuid: event.event_uuid,
    accepted: true,
    duplicate: Number(results[index]?.meta?.changes || 0) === 0
  }));

  return response({
    ok: true,
    accepted: acknowledgements.length,
    acknowledgements
  });
}

async function pullEvents(request, env, device) {
  const url = new URL(request.url);

  const afterRaw = url.searchParams.get("after") || "0";
  const limitRaw = url.searchParams.get("limit") || "100";

  if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) {
    return fail("مؤشر السحب أو الحد غير صالح");
  }

  const after = Number(afterRaw);
  const limit = Number(limitRaw);

  if (!Number.isSafeInteger(after) || after < 0) {
    return fail("مؤشر السحب خارج النطاق");
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    return fail("حد السحب غير صالح");
  }

  const safeLimit = Math.min(limit, 200);

  const result = await env.DB.prepare(
    `SELECT seq, event_uuid, source_device_id, entity_type,
            entity_uuid, operation, payload_json,
            client_created_at, server_created_at
     FROM sync_events
     WHERE store_id = ? AND seq > ?
     ORDER BY seq ASC
     LIMIT ?`
  ).bind(device.store_id, after, safeLimit).all();

  const rows = result.results || [];
  const events = [];

  for (const row of rows) {
    if (row.source_device_id === device.id) continue;

    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      throw new HttpError("حدث محفوظ تالف في قاعدة البيانات", 500);
    }

    events.push({
      seq: row.seq,
      event_uuid: row.event_uuid,
      entity_type: row.entity_type,
      entity_uuid: row.entity_uuid,
      operation: row.operation,
      payload,
      created_at: row.client_created_at,
      server_created_at: row.server_created_at
    });
  }

  return response({
    ok: true,
    events,
    next_cursor: rows.length ? rows[rows.length - 1].seq : after,
    scanned: rows.length
  });
}

async function syncStatus(env, device) {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS total_events
     FROM sync_events WHERE store_id = ?`
  ).bind(device.store_id).first();

  return response({
    ok: true,
    store_id: device.store_id,
    device_id: device.id,
    device_name: device.name,
    total_events: Number(result?.total_events || 0)
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "GET" && path === "/health") {
        return response({
          ok: true,
          service: "NRS Cash Pro Sync",
          version: "1.1.0"
        });
      }

      if (request.method === "POST" &&
          path === "/v1/admin/stores") {
        return await createStore(request, env);
      }

      const deviceListMatch = path.match(
        /^\/v1\/admin\/stores\/([^/]+)\/devices$/i
      );

      const deviceRevokeMatch = path.match(
        /^\/v1\/admin\/stores\/([^/]+)\/devices\/([^/]+)$/i
      );

      if (deviceListMatch || deviceRevokeMatch) {
        if (!await requireAdmin(request, env)) {
          return fail("غير مصرح", 401);
        }

        if (deviceListMatch && request.method === "GET") {
          return await listStoreDevices(
            request, env, deviceListMatch[1]
          );
        }

        if (deviceRevokeMatch && request.method === "DELETE") {
          return await revokeStoreDevice(
            request,
            env,
            deviceRevokeMatch[1],
            deviceRevokeMatch[2]
          );
        }

        return fail("طريقة الطلب غير مدعومة", 405);
      }

      if (request.method === "POST" &&
          path === "/v1/device/enroll") {
        return await enrollDevice(request, env);
      }

      if (path.startsWith("/v1/sync/")) {
        const device = await requireDevice(request, env);

        if (!device) return fail("رمز الجهاز غير صحيح أو ملغى", 401);

        if (request.method === "POST" && path === "/v1/sync/push") {
          return await pushEvents(request, env, device);
        }

        if (request.method === "GET" && path === "/v1/sync/pull") {
          return await pullEvents(request, env, device);
        }

        if (request.method === "GET" && path === "/v1/sync/status") {
          return await syncStatus(env, device);
        }
      }

      return fail("المسار غير موجود", 404);

    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        return fail("حدث خطأ داخلي في خدمة المزامنة", status);
      }

      return fail(error?.message || "طلب غير صالح", status);
    }
  }
};
