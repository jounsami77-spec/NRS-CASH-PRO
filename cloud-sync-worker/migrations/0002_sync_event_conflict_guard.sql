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
