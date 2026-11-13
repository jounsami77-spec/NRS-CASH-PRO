import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import worker, { validateEvent, canonicalJson, pushEvents } from "../src/index.js";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const SALE = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

function productEvent(operation, payload) {
  return {
    event_uuid: EVENT,
    entity_uuid: PRODUCT,
    entity_type: "product",
    operation,
    payload: { sync_uuid: PRODUCT, ...payload }
  };
}

test("product create valid", () => {
  assert.equal(validateEvent(productEvent("create", {
    name: "Test",
    price: 100,
    initial_stock: 10
  })), null);
});

test("product update valid", () => {
  assert.equal(validateEvent(productEvent("update", {
    name: "Test 2",
    price: 120
  })), null);
});

test("product delete valid", () => {
  assert.equal(validateEvent(productEvent("delete", {
    local_id: 4
  })), null);
});

test("stock adjustment valid", () => {
  assert.equal(validateEvent(productEvent("stock.adjust", {
    delta: -2,
    reason: "manual_adjustment"
  })), null);
});

test("reject invalid UUID", () => {
  const event = productEvent("create", {
    name: "Test",
    price: 100,
    initial_stock: 10
  });
  event.event_uuid = "bad";
  assert.notEqual(validateEvent(event), null);
});

test("reject mismatched sync UUID", () => {
  const event = productEvent("create", {
    name: "Test",
    price: 100,
    initial_stock: 10
  });
  event.payload.sync_uuid = SALE;
  assert.notEqual(validateEvent(event), null);
});

test("reject negative product price", () => {
  assert.notEqual(validateEvent(productEvent("create", {
    name: "Test",
    price: -1,
    initial_stock: 10
  })), null);
});

test("reject invalid stock delta", () => {
  assert.notEqual(validateEvent(productEvent("stock.adjust", {
    delta: 0
  })), null);
});

test("sale create valid", () => {
  const event = {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "create",
    payload: {
      sync_uuid: SALE,
      total: 200,
      items: [{
        product_sync_uuid: PRODUCT,
        quantity: 2,
        price: 100,
        subtotal: 200
      }]
    }
  };
  assert.equal(validateEvent(event), null);
});

test("reject sale with empty items", () => {
  const event = {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "create",
    payload: {
      sync_uuid: SALE,
      total: 0,
      items: []
    }
  };
  assert.notEqual(validateEvent(event), null);
});

test("reject sale with invalid quantity", () => {
  const event = {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "create",
    payload: {
      sync_uuid: SALE,
      total: 100,
      items: [{
        product_sync_uuid: PRODUCT,
        quantity: 0,
        price: 100,
        subtotal: 100
      }]
    }
  };
  assert.notEqual(validateEvent(event), null);
});

test("reject unsupported operation", () => {
  assert.notEqual(validateEvent(productEvent("drop-table", {})), null);
});

test("reject array payload", () => {
  const event = productEvent("create", {});
  event.payload = [];
  assert.notEqual(validateEvent(event), null);
});


test("sale accepts original invoice timestamp", () => {
  const event = {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "create",
    payload: {
      sync_uuid: SALE,
      created_at: "2026-11-03 12:30:00",
      total: 200,
      items: [{
        product_sync_uuid: PRODUCT,
        quantity: 2,
        price: 100,
        subtotal: 200
      }]
    }
  };

  assert.equal(validateEvent(event), null);
});

test("sale rejects invalid invoice timestamp", () => {
  const event = {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "create",
    payload: {
      sync_uuid: SALE,
      created_at: 12345,
      total: 200,
      items: [{
        product_sync_uuid: PRODUCT,
        quantity: 2,
        price: 100,
        subtotal: 200
      }]
    }
  };

  assert.notEqual(validateEvent(event), null);
});


const LINE = "44444444-4444-4444-8444-444444444444";

function saleSnapshot(overrides = {}) {
  return {
    event_uuid: EVENT,
    entity_uuid: SALE,
    entity_type: "sale",
    operation: "snapshot",
    payload: {
      sync_uuid: SALE,
      status: "sold",
      total: 200,
      created_at: "2026-11-09 12:00:00",
      customer_name: "",
      customer_phone: "",
      items: [{
        line_sync_uuid: LINE,
        product_sync_uuid: PRODUCT,
        name: "Test product",
        quantity: 2,
        base_quantity: 2,
        price: 100,
        subtotal: 200,
        is_cancelled: false,
        cancelled_at: null
      }],
      stock_deltas: [{
        product_sync_uuid: PRODUCT,
        delta: -2
      }],
      ...overrides
    }
  };
}

test("sale snapshot valid", () => {
  assert.equal(validateEvent(saleSnapshot()), null);
});

test("sale snapshot accepts a valid unit", () => {
  const event = saleSnapshot();
  event.payload.items[0].unit = "box";
  assert.equal(validateEvent(event), null);
});

test("sale snapshot rejects an empty unit", () => {
  const event = saleSnapshot();
  event.payload.items[0].unit = "   ";
  assert.match(
    validateEvent(event),
    /وحدة قياس عنصر الفاتورة غير صالحة/
  );
});

test("sale snapshot accepts legacy items without unit", () => {
  const event = saleSnapshot();
  assert.equal(
    Object.hasOwn(event.payload.items[0], "unit"),
    false
  );
  assert.equal(validateEvent(event), null);
});



test("sale snapshot supports cancelled invoice", () => {
  const event = saleSnapshot({
    status: "cancelled",
    total: 0,
    items: [{
      line_sync_uuid: LINE,
      product_sync_uuid: PRODUCT,
      name: "Test product",
      quantity: 2,
      base_quantity: 2,
      price: 100,
      subtotal: 200,
      is_cancelled: true,
      cancelled_at: "2026-11-09 12:10:00"
    }],
    stock_deltas: [{
      product_sync_uuid: PRODUCT,
      delta: 2
    }]
  });
  assert.equal(validateEvent(event), null);
});

test("sale snapshot rejects duplicate line UUID", () => {
  const event = saleSnapshot();
  event.payload.items.push({ ...event.payload.items[0] });
  assert.notEqual(validateEvent(event), null);
});

test("sale snapshot rejects invalid stock delta", () => {
  const event = saleSnapshot({
    stock_deltas: [{ product_sync_uuid: PRODUCT, delta: 0 }]
  });
  assert.notEqual(validateEvent(event), null);
});

test("sale snapshot rejects duplicate product stock deltas", () => {
  const event = saleSnapshot({
    stock_deltas: [
      { product_sync_uuid: PRODUCT, delta: -1 },
      { product_sync_uuid: PRODUCT, delta: 1 }
    ]
  });
  assert.notEqual(validateEvent(event), null);
});

test("sale snapshot allows historical line with deleted product", () => {
  const event = saleSnapshot({
    stock_deltas: [],
    items: [{
      line_sync_uuid: LINE,
      product_sync_uuid: null,
      name: "Deleted product",
      quantity: 1,
      base_quantity: 1,
      price: 50,
      subtotal: 50,
      is_cancelled: true,
      cancelled_at: null
    }]
  });
  assert.equal(validateEvent(event), null);
});

test("sale snapshot rejects unsupported status", () => {
  assert.notEqual(
    validateEvent(saleSnapshot({ status: "pending" })),
    null
  );
});

test("canonical JSON ignores object key order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: 1 }),
    canonicalJson({ a: 1, b: 2 })
  );
});

test("canonical JSON preserves array order", () => {
  assert.notEqual(
    canonicalJson([1, 2]),
    canonicalJson([2, 1])
  );
});


// قاعدة D1 وهمية لاختبار pushEvents دون اتصال بخادم أو قاعدة بيانات حقيقية.
function fakeD1(initialRows = []) {
  const rows = new Map();
  let batchCalls = 0;

  for (const row of initialRows) {
    rows.set(`${row.store_id}:${row.event_uuid}`, { ...row });
  }

  return {
    rows,
    get batchCalls() {
      return batchCalls;
    },
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          const [storeId, eventUuid] = this.values;
          return rows.get(`${storeId}:${eventUuid}`) || null;
        }
      };
      return statement;
    },
    async batch(statements) {
      batchCalls++;
      return statements.map(statement => {
        const [
          store_id,
          event_uuid,
          source_device_id,
          entity_type,
          entity_uuid,
          operation,
          payload_json,
          client_created_at,
          server_created_at
        ] = statement.values;

        const key = `${store_id}:${event_uuid}`;

        if (rows.has(key)) {
          return { meta: { changes: 0 } };
        }

        rows.set(key, {
          store_id,
          event_uuid,
          source_device_id,
          entity_type,
          entity_uuid,
          operation,
          payload_json,
          client_created_at,
          server_created_at
        });

        return { meta: { changes: 1 } };
      });
    }
  };
}

const TEST_STORE = "55555555-5555-4555-8555-555555555555";
const TEST_DEVICE = "66666666-6666-4666-8666-666666666666";
const OTHER_DEVICE = "77777777-7777-4777-8777-777777777777";
const EVENT_NEW = "88888888-8888-4888-8888-888888888888";
const EVENT_CONFLICT = "99999999-9999-4999-8999-999999999999";
const PRODUCT_NEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function pushProductEvent(eventUuid, productUuid, price = 100) {
  return {
    event_uuid: eventUuid,
    entity_uuid: productUuid,
    entity_type: "product",
    operation: "create",
    created_at: "2026-11-10T10:00:00.000Z",
    payload: {
      sync_uuid: productUuid,
      name: "Test product",
      price,
      initial_stock: 5
    }
  };
}

async function callPush(db, events) {
  const request = new Request("https://worker.test/v1/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events })
  });

  return pushEvents(request, { DB: db }, {
    id: TEST_DEVICE,
    store_id: TEST_STORE
  });
}

test("pushEvents rejects stored UUID conflict before writing", async () => {
  const conflictingEvent = pushProductEvent(
    EVENT_CONFLICT,
    PRODUCT_OLD,
    100
  );

  const db = fakeD1([{
    store_id: TEST_STORE,
    event_uuid: EVENT_CONFLICT,
    source_device_id: OTHER_DEVICE,
    entity_type: "product",
    entity_uuid: PRODUCT_OLD,
    operation: "create",
    payload_json: JSON.stringify(conflictingEvent.payload),
    client_created_at: conflictingEvent.created_at
  }]);

  const freshEvent = pushProductEvent(EVENT_NEW, PRODUCT_NEW);
  const response = await callPush(db, [freshEvent, conflictingEvent]);
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.ok, false);
  assert.equal(db.batchCalls, 0);
  assert.equal(db.rows.size, 1);
  assert.equal(
    db.rows.has(`${TEST_STORE}:${EVENT_NEW}`),
    false
  );
});

test("pushEvents rejects conflicting duplicate UUIDs inside request", async () => {
  const db = fakeD1();

  const first = pushProductEvent(EVENT_NEW, PRODUCT_NEW, 100);
  const second = pushProductEvent(EVENT_NEW, PRODUCT_NEW, 250);

  const response = await callPush(db, [first, second]);
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.ok, false);
  assert.equal(db.batchCalls, 0);
  assert.equal(db.rows.size, 0);
});

test("pushEvents accepts identical retry without duplicate insertion", async () => {
  const event = pushProductEvent(EVENT_NEW, PRODUCT_NEW);

  const db = fakeD1([{
    store_id: TEST_STORE,
    event_uuid: EVENT_NEW,
    source_device_id: TEST_DEVICE,
    entity_type: event.entity_type,
    entity_uuid: event.entity_uuid,
    operation: event.operation,
    payload_json: JSON.stringify(event.payload),
    client_created_at: event.created_at
  }]);

  const response = await callPush(db, [event]);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.acknowledgements[0].duplicate, true);
  assert.equal(db.batchCalls, 1);
  assert.equal(db.rows.size, 1);
});

test("pushEvents maps D1 trigger conflict to HTTP 409", async () => {
  const db = fakeD1();
  let batchCalled = false;

  db.batch = async () => {
    batchCalled = true;
    throw new Error(
      "D1_ERROR: NRS_EVENT_UUID_CONFLICT"
    );
  };

  const event = pushProductEvent(EVENT_NEW, PRODUCT_NEW);
  const response = await callPush(db, [event]);
  const result = await response.json();

  assert.equal(batchCalled, true);
  assert.equal(response.status, 409);
  assert.equal(result.ok, false);
  assert.match(result.error, /تعارض/);
  assert.equal(db.rows.size, 0);
});


// اختبارات مسارات المصادقة والعزل عبر نقطة الدخول الفعلية للـ Worker.
function authTestDb(options = {}) {
  const expectedDevice = options.device === false
    ? null
    : {
        id: TEST_DEVICE,
        store_id: TEST_STORE,
        name: "Test device"
      };

  const calls = {
    deviceLookup: 0,
    statusStoreIds: [],
    lastSeenUpdates: 0
  };

  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM devices")) {
            calls.deviceLookup++;
            return expectedDevice;
          }

          if (sql.includes("COUNT(*) AS total_events")) {
            calls.statusStoreIds.push(this.values[0]);
            return { total_events: 3 };
          }

          throw new Error("استعلام غير متوقع في اختبار المصادقة");
        },
        async run() {
          if (/UPDATE devices\s+SET last_seen_at/i.test(sql)) {
            calls.lastSeenUpdates++;
          }
          return { meta: { changes: 1 } };
        }
      };

      return statement;
    }
  };
}

test("worker.fetch rejects admin request without configured secret", async () => {
  const db = authTestDb();

  const request = new Request(
    "https://worker.test/v1/admin/stores",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store_name: "Test Store" })
    }
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 503);
  assert.equal(result.ok, false);
});

test("worker.fetch rejects admin request with wrong bearer secret", async () => {
  const db = authTestDb();

  const request = new Request(
    "https://worker.test/v1/admin/stores",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-secret"
      },
      body: JSON.stringify({ store_name: "Test Store" })
    }
  );

  const response = await worker.fetch(request, {
    DB: db,
    ADMIN_BOOTSTRAP_SECRET: "correct-secret"
  });
  const result = await response.json();

  assert.equal(response.status, 401);
  assert.equal(result.ok, false);
});

test("worker.fetch rejects sync request without device token", async () => {
  const db = authTestDb();

  const request = new Request(
    "https://worker.test/v1/sync/status"
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 401);
  assert.equal(result.ok, false);
  assert.equal(db.calls.deviceLookup, 0);
});

test("worker.fetch rejects unknown or revoked device token", async () => {
  const db = authTestDb({ device: false });

  const request = new Request(
    "https://worker.test/v1/sync/status",
    {
      headers: { authorization: "Bearer invalid-device-token" }
    }
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 401);
  assert.equal(result.ok, false);
  assert.equal(db.calls.deviceLookup, 1);
  assert.equal(db.calls.statusStoreIds.length, 0);
});

test("worker.fetch scopes sync status to authenticated device store", async () => {
  const db = authTestDb();
  const otherStore = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const request = new Request(
    `https://worker.test/v1/sync/status?store_id=${otherStore}`,
    {
      headers: { authorization: "Bearer valid-test-device-token" }
    }
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.store_id, TEST_STORE);
  assert.notEqual(result.store_id, otherStore);
  assert.deepEqual(db.calls.statusStoreIds, [TEST_STORE]);
  assert.equal(db.calls.lastSeenUpdates, 1);
});



// اختبارات عزل متجرين عبر نقاط Push وPull الفعلية.
const OTHER_STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TENANT_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_PRODUCT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function tenantIsolationDb() {
  const calls = {
    pushStoreIds: [],
    pullStoreIds: [],
    inserted: [],
    lastSeen: 0
  };

  const device = {
    id: TEST_DEVICE,
    store_id: TEST_STORE,
    name: "Store A device"
  };

  const storedRows = [
    {
      seq: 1,
      store_id: TEST_STORE,
      event_uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      source_device_id: OTHER_DEVICE,
      entity_type: "product",
      entity_uuid: PRODUCT_NEW,
      operation: "create",
      payload_json: JSON.stringify({
        sync_uuid: PRODUCT_NEW,
        name: "Product from Store A",
        price: 100,
        initial_stock: 5
      }),
      client_created_at: "",
      server_created_at: "2026-11-10T10:00:00.000Z"
    },
    {
      seq: 2,
      store_id: OTHER_STORE,
      event_uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      source_device_id: OTHER_DEVICE,
      entity_type: "product",
      entity_uuid: PRODUCT_OLD,
      operation: "create",
      payload_json: JSON.stringify({
        sync_uuid: PRODUCT_OLD,
        name: "Private product from Store B",
        price: 999,
        initial_stock: 50
      }),
      client_created_at: "",
      server_created_at: "2026-11-10T10:01:00.000Z"
    }
  ];

  return {
    calls,

    prepare(sql) {
      const statement = {
        sql,
        values: [],

        bind(...values) {
          this.values = values;
          return this;
        },

        async first() {
          if (sql.includes("FROM devices")) return device;

          if (sql.includes("FROM sync_events")) {
            const [storeId, eventUuid] = this.values;
            calls.pushStoreIds.push(storeId);

            return calls.inserted.find(
              row => row.store_id === storeId &&
                     row.event_uuid === eventUuid
            ) || null;
          }

          throw new Error("Unexpected first() query: " + sql);
        },

        async run() {
          if (/UPDATE devices\s+SET last_seen_at/i.test(sql)) {
            calls.lastSeen++;
          }
          return { meta: { changes: 1 } };
        },

        async all() {
          assert.match(
            sql,
            /WHERE\s+store_id\s*=\s*\?\s+AND\s+seq\s*>\s*\?/i,
            "Pull query must scope by authenticated store_id"
          );

          const [storeId, after, limit] = this.values;
          calls.pullStoreIds.push(storeId);

          return {
            results: storedRows
              .filter(row =>
                row.store_id === storeId && row.seq > after
              )
              .sort((a, b) => a.seq - b.seq)
              .slice(0, limit)
          };
        }
      };

      return statement;
    },

    async batch(statements) {
      return statements.map(statement => {
        const [
          store_id,
          event_uuid,
          source_device_id,
          entity_type,
          entity_uuid,
          operation,
          payload_json,
          client_created_at,
          server_created_at
        ] = statement.values;

        calls.inserted.push({
          store_id,
          event_uuid,
          source_device_id,
          entity_type,
          entity_uuid,
          operation,
          payload_json,
          client_created_at,
          server_created_at
        });

        return { meta: { changes: 1 } };
      });
    }
  };
}

test("Push cannot write into another store using forged store_id", async () => {
  const db = tenantIsolationDb();

  const event = {
    event_uuid: TENANT_EVENT,
    entity_uuid: TENANT_PRODUCT,
    entity_type: "product",
    operation: "create",
    created_at: "2026-11-10T10:00:00.000Z",
    payload: {
      sync_uuid: TENANT_PRODUCT,
      name: "Tenant isolation test",
      price: 100,
      initial_stock: 5,
      store_id: OTHER_STORE
    }
  };

  const request = new Request(
    "https://worker.test/v1/sync/push",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer valid-test-device-token"
      },
      body: JSON.stringify({
        store_id: OTHER_STORE,
        events: [event]
      })
    }
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(db.calls.inserted.length, 1);

  assert.equal(db.calls.inserted[0].store_id, TEST_STORE);
  assert.notEqual(db.calls.inserted[0].store_id, OTHER_STORE);

  assert.deepEqual(db.calls.pushStoreIds, [TEST_STORE]);
  assert.equal(db.calls.lastSeen, 1);
});

test("Pull returns only events belonging to authenticated store", async () => {
  const db = tenantIsolationDb();

  const request = new Request(
    `https://worker.test/v1/sync/pull?after=0&limit=100&store_id=${OTHER_STORE}`,
    {
      headers: {
        authorization: "Bearer valid-test-device-token"
      }
    }
  );

  const response = await worker.fetch(request, { DB: db });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);

  assert.deepEqual(db.calls.pullStoreIds, [TEST_STORE]);
  assert.equal(result.events.length, 1);

  assert.equal(
    result.events[0].payload.name,
    "Product from Store A"
  );

  assert.notEqual(
    result.events[0].payload.name,
    "Private product from Store B"
  );

  assert.equal(result.next_cursor, 1);
  assert.equal(result.scanned, 1);
  assert.equal(db.calls.lastSeen, 1);
});



// قاعدة اختبار مستقلة للتحقق من صفحات السحب ومؤشر المزامنة.
function paginationTestDb(rows) {
  const calls = {
    pull: [],
    lastSeen: 0
  };

  const device = {
    id: TEST_DEVICE,
    store_id: TEST_STORE,
    name: "Pagination test device"
  };

  return {
    calls,

    prepare(sql) {
      const statement = {
        sql,
        values: [],

        bind(...values) {
          this.values = values;
          return this;
        },

        async first() {
          if (sql.includes("FROM devices")) return device;
          throw new Error("Unexpected first() pagination query");
        },

        async run() {
          if (/UPDATE devices\s+SET last_seen_at/i.test(sql)) {
            calls.lastSeen++;
          }
          return { meta: { changes: 1 } };
        },

        async all() {
          assert.match(
            sql,
            /WHERE\s+store_id\s*=\s*\?\s+AND\s+seq\s*>\s*\?/i
          );

          const [storeId, after, limit] = this.values;
          calls.pull.push({ storeId, after, limit });

          return {
            results: rows
              .filter(row =>
                row.store_id === storeId && row.seq > after
              )
              .sort((a, b) => a.seq - b.seq)
              .slice(0, limit)
          };
        }
      };

      return statement;
    }
  };
}

function paginationRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;

    return {
      seq,
      store_id: TEST_STORE,
      event_uuid: `pagination-event-${seq}`,
      source_device_id: seq % 3 === 0
        ? TEST_DEVICE
        : OTHER_DEVICE,
      entity_type: "product",
      entity_uuid: PRODUCT_NEW,
      operation: "create",
      payload_json: JSON.stringify({
        sync_uuid: PRODUCT_NEW,
        name: `Product ${seq}`,
        price: 100,
        initial_stock: 5
      }),
      client_created_at: "",
      server_created_at: "2026-11-10T10:00:00.000Z"
    };
  });
}

async function callPull(db, query) {
  const request = new Request(
    `https://worker.test/v1/sync/pull?${query}`,
    {
      headers: {
        authorization: "Bearer valid-test-device-token"
      }
    }
  );

  return worker.fetch(request, { DB: db });
}

test("pull cursor advances correctly while skipping own device events", async () => {
  const db = paginationTestDb(paginationRows(10));

  const firstResponse = await callPull(db, "after=0&limit=2");
  const first = await firstResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(first.events.map(event => event.seq), [1, 2]);
  assert.equal(first.scanned, 2);
  assert.equal(first.next_cursor, 2);

  const secondResponse = await callPull(
    db,
    `after=${first.next_cursor}&limit=2`
  );
  const second = await secondResponse.json();

  assert.equal(secondResponse.status, 200);
  assert.deepEqual(second.events.map(event => event.seq), [4]);
  assert.equal(second.scanned, 2);
  assert.equal(second.next_cursor, 4);

  const thirdResponse = await callPull(
    db,
    `after=${second.next_cursor}&limit=2`
  );
  const third = await thirdResponse.json();

  assert.equal(thirdResponse.status, 200);
  assert.deepEqual(third.events.map(event => event.seq), [5]);
  assert.equal(third.scanned, 2);
  assert.equal(third.next_cursor, 6);

  assert.equal(db.calls.pull.length, 3);
  assert.ok(
    db.calls.pull.every(call => call.storeId === TEST_STORE)
  );
});

test("pull clamps requested page size to 200 events", async () => {
  const db = paginationTestDb(paginationRows(205));

  const response = await callPull(db, "after=0&limit=999");
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 200);
  assert.equal(result.events.length, 134);
  assert.equal(result.next_cursor, 200);
  assert.equal(db.calls.pull[0].limit, 200);
});

test("pull rejects invalid cursor and limit values before database scan", async () => {
  const invalidQueries = [
    "after=-1&limit=100",
    "after=1.5&limit=100",
    "after=1e3&limit=100",
    "after=9007199254740992&limit=100",
    "after=0&limit=0",
    "after=0&limit=-1",
    "after=0&limit=1.5",
    "after=0&limit=9007199254740992"
  ];

  for (const query of invalidQueries) {
    const db = paginationTestDb(paginationRows(5));
    const response = await callPull(db, query);
    const result = await response.json();

    assert.equal(
      response.status,
      400,
      `Expected HTTP 400 for ${query}`
    );
    assert.equal(result.ok, false);
    assert.equal(db.calls.pull.length, 0);
  }
});


// قاعدة D1 وهمية مخصصة لاختبار تسجيل الأجهزة.
const TEST_PAIRING_CODE = "NRS-PAIRING-CODE-TEST-2026-123456";

function enrollmentTestDb(options = {}) {
  const expectedHash = createHash("sha256")
    .update(TEST_PAIRING_CODE)
    .digest("hex");

  const state = {
    selectCalls: 0,
    batchCalls: 0,
    statements: [],
    pairing: options.pairing === false
      ? null
      : { store_id: TEST_STORE }
  };

  return {
    state,

    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },

        async first() {
          if (sql.includes("FROM pairing_codes")) {
            state.selectCalls++;
            if (this.values[0] !== expectedHash) return null;
            return state.pairing;
          }

          throw new Error("استعلام غير متوقع في اختبار التسجيل");
        }
      };

      return statement;
    },

    async batch(statements) {
      state.batchCalls++;
      state.statements = statements;

      if (options.batchError) {
        throw new Error("simulated D1 batch failure");
      }

      return options.batchResults || [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ];
    }
  };
}

function enrollmentRequest(body) {
  return new Request("https://worker.test/v1/device/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("enrollment accepts a valid unused pairing code", async () => {
  const db = enrollmentTestDb();

  const response = await worker.fetch(
    enrollmentRequest({
      pairing_code: TEST_PAIRING_CODE,
      device_name: "NRS Test Phone"
    }),
    { DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.ok, true);
  assert.match(
    result.device_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.equal(result.device_name, "NRS Test Phone");
  assert.match(result.device_token, /^[A-Za-z0-9_-]{43}$/);

  assert.equal(db.state.selectCalls, 1);
  assert.equal(db.state.batchCalls, 1);
  assert.equal(db.state.statements.length, 2);

  const insertValues = db.state.statements[0].values;
  assert.match(insertValues[2], /^[a-f0-9]{64}$/);
  assert.notEqual(insertValues[2], result.device_token);

  assert.match(db.state.statements[0].sql, /INSERT INTO devices/);
  assert.match(db.state.statements[1].sql, /UPDATE pairing_codes/);
});

test("enrollment rejects JSON null without internal error", async () => {
  const db = enrollmentTestDb();

  const response = await worker.fetch(
    enrollmentRequest(null),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("enrollment rejects JSON array without internal error", async () => {
  const db = enrollmentTestDb();

  const response = await worker.fetch(
    enrollmentRequest([]),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("enrollment rejects malformed JSON", async () => {
  const db = enrollmentTestDb();

  const response = await worker.fetch(
    enrollmentRequest("{"),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("enrollment rejects used expired or unknown pairing code", async () => {
  const db = enrollmentTestDb({ pairing: false });

  const response = await worker.fetch(
    enrollmentRequest({
      pairing_code: TEST_PAIRING_CODE,
      device_name: "NRS Test Phone"
    }),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 401);
  assert.equal(result.ok, false);
  assert.equal(db.state.selectCalls, 1);
  assert.equal(db.state.batchCalls, 0);
});

test("enrollment rejects invalid batch result", async () => {
  const db = enrollmentTestDb({
    batchResults: [
      { meta: { changes: 0 } },
      { meta: { changes: 0 } }
    ]
  });

  const response = await worker.fetch(
    enrollmentRequest({
      pairing_code: TEST_PAIRING_CODE
    }),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 1);
  assert.equal(db.state.statements.length, 2);
});

test("enrollment hides internal D1 batch errors", async () => {
  const db = enrollmentTestDb({ batchError: true });

  const response = await worker.fetch(
    enrollmentRequest({
      pairing_code: TEST_PAIRING_CODE
    }),
    { DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 500);
  assert.equal(result.ok, false);
  assert.doesNotMatch(
    result.error,
    /simulated D1 batch failure/
  );
});


// قاعدة D1 وهمية لاختبار إنشاء المتجر ورمز الربط.
function createStoreTestDb(options = {}) {
  const state = {
    batchCalls: 0,
    statements: []
  };

  return {
    state,

    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        }
      };
    },

    async batch(statements) {
      state.batchCalls++;
      state.statements = statements;

      if (options.batchError) {
        throw new Error("simulated create store D1 failure");
      }

      return [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ];
    }
  };
}

function createStoreRequest(body) {
  return new Request("https://worker.test/v1/admin/stores", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-admin-secret"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const CREATE_STORE_ENV = {
  ADMIN_BOOTSTRAP_SECRET: "test-admin-secret"
};

test("createStore creates store and hashed pairing code", async () => {
  const db = createStoreTestDb();

  const response = await worker.fetch(
    createStoreRequest({ store_name: "NRS Hardware" }),
    { ...CREATE_STORE_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.ok, true);
  assert.equal(result.store_name, "NRS Hardware");
  assert.match(
    result.store_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

  assert.equal(result.expires_in_seconds, 900);
  assert.match(result.pairing_code, /^[A-Za-z0-9_-]{32}$/);

  assert.equal(db.state.batchCalls, 1);
  assert.equal(db.state.statements.length, 2);

  const storeInsert = db.state.statements[0];
  const pairingInsert = db.state.statements[1];

  assert.match(storeInsert.sql, /INSERT INTO stores/);
  assert.match(pairingInsert.sql, /INSERT INTO pairing_codes/);

  assert.equal(storeInsert.values[0], result.store_id);
  assert.equal(storeInsert.values[1], "NRS Hardware");

  const [storedHash, pairingStoreId, expiresAt] =
    pairingInsert.values;

  assert.match(storedHash, /^[a-f0-9]{64}$/);
  assert.notEqual(storedHash, result.pairing_code);
  assert.equal(pairingStoreId, result.store_id);

  const remainingMs = expiresAt - Date.now();
  assert.ok(remainingMs > 14 * 60 * 1000);
  assert.ok(remainingMs <= 15 * 60 * 1000);
});

test("createStore rejects JSON null", async () => {
  const db = createStoreTestDb();

  const response = await worker.fetch(
    createStoreRequest(null),
    { ...CREATE_STORE_ENV, DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("createStore rejects JSON array", async () => {
  const db = createStoreTestDb();

  const response = await worker.fetch(
    createStoreRequest([]),
    { ...CREATE_STORE_ENV, DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("createStore rejects malformed JSON", async () => {
  const db = createStoreTestDb();

  const response = await worker.fetch(
    createStoreRequest("{"),
    { ...CREATE_STORE_ENV, DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.state.batchCalls, 0);
});

test("createStore rejects non-string and short store names", async () => {
  for (const storeName of [123, {}, "A", "   "]) {
    const db = createStoreTestDb();

    const response = await worker.fetch(
      createStoreRequest({ store_name: storeName }),
      { ...CREATE_STORE_ENV, DB: db }
    );
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.equal(result.ok, false);
    assert.equal(db.state.batchCalls, 0);
  }
});

test("createStore hides internal D1 errors", async () => {
  const db = createStoreTestDb({ batchError: true });

  const response = await worker.fetch(
    createStoreRequest({ store_name: "NRS Hardware" }),
    { ...CREATE_STORE_ENV, DB: db }
  );
  const result = await response.json();

  assert.equal(response.status, 500);
  assert.equal(result.ok, false);
  assert.doesNotMatch(
    result.error,
    /simulated create store D1 failure/
  );
});


// قاعدة D1 وهمية لمسارات إدارة الأجهزة.
function deviceAdminTestDb(options = {}) {
  const calls = {
    listStoreIds: [],
    revokeValues: [],
    listRows: options.rows || [
      {
        id: TEST_DEVICE,
        name: "Owner Android",
        created_at: "2026-11-10T10:00:00.000Z",
        last_seen_at: "2026-11-10T11:00:00.000Z",
        revoked_at: null
      }
    ]
  };

  return {
    calls,
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          calls.listStoreIds.push(this.values[0]);
          return { results: calls.listRows };
        },
        async run() {
          calls.revokeValues.push(this.values);
          return {
            meta: {
              changes: options.revokeChanges === undefined
                ? 1
                : options.revokeChanges
            }
          };
        }
      };
    }
  };
}

function deviceAdminRequest(path, method = "GET", secret = "test-admin-secret") {
  return new Request("https://worker.test" + path, {
    method,
    headers: {
      authorization: "Bearer " + secret
    }
  });
}

const DEVICE_ADMIN_ENV = {
  ADMIN_BOOTSTRAP_SECRET: "test-admin-secret"
};

test("admin lists devices without exposing token hashes", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(`/v1/admin/stores/${TEST_STORE}/devices`),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.store_id, TEST_STORE);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].id, TEST_DEVICE);
  assert.equal(result.devices[0].name, "Owner Android");
  assert.equal(result.devices[0].revoked_at, null);
  assert.deepEqual(db.calls.listStoreIds, [TEST_STORE]);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /token_hash|device_token/);
});

test("admin device list rejects invalid store UUID", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest("/v1/admin/stores/not-a-uuid/devices"),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(db.calls.listStoreIds.length, 0);
});

test("admin device list rejects wrong admin secret", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices`,
      "GET",
      "wrong-secret"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  assert.equal(response.status, 401);
  assert.equal(db.calls.listStoreIds.length, 0);
});

test("admin device list rejects missing admin configuration", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(`/v1/admin/stores/${TEST_STORE}/devices`),
    { DB: db }
  );

  assert.equal(response.status, 503);
  assert.equal(db.calls.listStoreIds.length, 0);
});

test("admin revokes device within the specified store", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices/${TEST_DEVICE}`,
      "DELETE"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.equal(result.store_id, TEST_STORE);
  assert.equal(result.device_id, TEST_DEVICE);
  assert.ok(Number.isFinite(Date.parse(result.revoked_at)));

  assert.equal(db.calls.revokeValues.length, 1);

  const [revokedAt, deviceId, storeId] = db.calls.revokeValues[0];

  assert.equal(deviceId, TEST_DEVICE);
  assert.equal(storeId, TEST_STORE);
  assert.equal(revokedAt, result.revoked_at);
});

test("admin cannot revoke device from another store", async () => {
  const db = deviceAdminTestDb({ revokeChanges: 0 });
  const otherStore = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${otherStore}/devices/${TEST_DEVICE}`,
      "DELETE"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 404);
  assert.equal(result.ok, false);

  const [, deviceId, storeId] = db.calls.revokeValues[0];
  assert.equal(deviceId, TEST_DEVICE);
  assert.equal(storeId, otherStore);
});

test("admin revoke rejects invalid device UUID without database update", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices/not-a-uuid`,
      "DELETE"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  assert.equal(response.status, 400);
  assert.equal(db.calls.revokeValues.length, 0);
});

test("admin revoke returns not found for already revoked or unknown device", async () => {
  const db = deviceAdminTestDb({ revokeChanges: 0 });

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices/${TEST_DEVICE}`,
      "DELETE"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const result = await response.json();

  assert.equal(response.status, 404);
  assert.equal(result.ok, false);
});

test("admin device routes reject unsupported HTTP methods", async () => {
  const db = deviceAdminTestDb();

  const response = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices`,
      "POST"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  assert.equal(response.status, 405);
  assert.equal(db.calls.listStoreIds.length, 0);
  assert.equal(db.calls.revokeValues.length, 0);
});


test("admin revoke immediately blocks device sync access", async () => {
  const state = {
    revokedAt: null,
    deviceLookups: 0,
    statusQueries: 0,
    revokeValues: null
  };

  const db = {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM devices")) {
            state.deviceLookups++;

            if (state.revokedAt !== null) return null;

            return {
              id: TEST_DEVICE,
              store_id: TEST_STORE,
              name: "Owner Android"
            };
          }

          if (sql.includes("COUNT(*) AS total_events")) {
            state.statusQueries++;
            return { total_events: 3 };
          }

          throw new Error("Unexpected query in revocation integration test");
        },
        async run() {
          if (/UPDATE devices\s+SET revoked_at/i.test(sql)) {
            state.revokeValues = this.values;

            const [revokedAt, deviceId, storeId] = this.values;

            if (
              deviceId === TEST_DEVICE &&
              storeId === TEST_STORE &&
              state.revokedAt === null
            ) {
              state.revokedAt = revokedAt;
              return { meta: { changes: 1 } };
            }

            return { meta: { changes: 0 } };
          }

          if (sql.includes("UPDATE devices SET last_seen_at")) {
            return { meta: { changes: 1 } };
          }

          throw new Error("Unexpected update in revocation integration test");
        }
      };
    }
  };

  const adminResponse = await worker.fetch(
    deviceAdminRequest(
      `/v1/admin/stores/${TEST_STORE}/devices/${TEST_DEVICE}`,
      "DELETE"
    ),
    { ...DEVICE_ADMIN_ENV, DB: db }
  );

  const adminResult = await adminResponse.json();

  assert.equal(adminResponse.status, 200);
  assert.equal(adminResult.revoked, true);
  assert.ok(state.revokedAt);
  assert.equal(state.revokeValues[1], TEST_DEVICE);
  assert.equal(state.revokeValues[2], TEST_STORE);

  const syncResponse = await worker.fetch(
    new Request("https://worker.test/v1/sync/status", {
      headers: {
        authorization: "Bearer previously-valid-device-token"
      }
    }),
    { DB: db }
  );

  const syncResult = await syncResponse.json();

  assert.equal(syncResponse.status, 401);
  assert.equal(syncResult.ok, false);
  assert.equal(state.deviceLookups, 1);
  assert.equal(state.statusQueries, 0);
});
