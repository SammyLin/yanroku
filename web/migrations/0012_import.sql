-- Export / import (src/transfer.ts): where an imported recording came from ("<origin>#<old id>", unique per user so a
-- second import of the same zip skips it). An imported row is status 'importing' until its audio is complete: hidden from
-- lists, never claimed by a runner.
ALTER TABLE recordings ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX recordings_import_key ON recordings(user_id, import_key) WHERE import_key IS NOT NULL;
