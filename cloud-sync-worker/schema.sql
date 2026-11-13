PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(store_id) REFERENCES stores(id)
);

CREATE INDEX IF NOT EXISTS idx_pairing_expiry
ON pairing_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY(store_id) REFERENCES stores(id)
);

CREATE INDEX IF NOT EXISTS idx_devices_store
ON devices(store_id, revoked_at);

CREATE TABLE IF NOT EXISTS sync_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    event_uuid TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_uuid TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    client_created_at TEXT,
    server_created_at TEXT NOT NULL,
    UNIQUE(store_id, event_uuid),
    FOREIGN KEY(store_id) REFERENCES stores(id),
    FOREIGN KEY(source_device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_sync_events_store_seq
ON sync_events(store_id, seq);

CREATE INDEX IF NOT EXISTS idx_sync_events_source
ON sync_events(store_id, source_device_id, seq);
-- NRS migration 0002:
-- Reject reuse of an event UUID with different content.
-- Existing rows are preserved.

-- NRS migration 0002:
-- Reject reuse of an event UUID with different semantic content.
-- Existing rows are preserved, including legacy JSON key ordering.

CREATE TRIGGER IF NOT EXISTS trg_sync_events_event_uuid_conflict
BEFORE INSERT ON sync_events
WHEN EXISTS (
    SELECT 1
    FROM sync_events AS old
    WHERE old.store_id = NEW.store_id
      AND old.event_uuid = NEW.event_uuid
      AND (
          old.source_device_id IS NOT NEW.source_device_id
          OR old.entity_type IS NOT NEW.entity_type
          OR old.entity_uuid IS NOT NEW.entity_uuid
          OR old.operation IS NOT NEW.operation
          OR old.client_created_at IS NOT NEW.client_created_at

          OR EXISTS (
              SELECT fullkey, type, atom
              FROM json_tree(old.payload_json)
              EXCEPT
              SELECT fullkey, type, atom
              FROM json_tree(NEW.payload_json)
          )

          OR EXISTS (
              SELECT fullkey, type, atom
              FROM json_tree(NEW.payload_json)
              EXCEPT
              SELECT fullkey, type, atom
              FROM json_tree(old.payload_json)
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'NRS_EVENT_UUID_CONFLICT');
END;
