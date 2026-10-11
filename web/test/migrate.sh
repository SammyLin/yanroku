#!/bin/sh
# Applies 0011_users.sql to a local D1 holding self-host-shaped data (0001-0010 + rows in every table) and asserts
# that no row and no person link is lost (DROP TABLE people fires FK actions; the migration must undo them).
# Run from web/: sh test/migrate.sh
set -eu
cd "$(dirname "$0")/.."
dir=$(mktemp -d "${TMPDIR:-/tmp}/yanroku-migrate.XXXXXX")
trap 'rm -rf "$dir"' EXIT
sql() { npx wrangler d1 execute noteapp --local --persist-to "$dir" "$@" >/dev/null; }
q() { npx wrangler d1 execute noteapp --local --persist-to "$dir" --json --command "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))'; }

# schema as it is live on self-host (0001-0010) + one or more rows in every table, in one execute
{ for f in migrations/00*.sql; do case "$f" in *0011_*) ;; *) cat "$f"; echo ;; esac; done; echo "
INSERT INTO folders(id, parent_id, name) VALUES(1, NULL, 'Work'), (2, 1, 'Sub');
INSERT INTO recordings(id, title, filename, status, folder_id, source_key, play_key) VALUES
  (1, 'one', 'one.m4a', 'done', 1, NULL, 'rec/1/play.m4a'), (2, 'two', 'two.m4a', 'queued', 2, 'rec/2/source.m4a', NULL);
INSERT INTO people(id, name) VALUES(1, 'Alice'), (2, 'Bob');
INSERT INTO speakers(id, recording_id, label, display_name, embedding, emb_model, person_id, suggest_person_id, suggest_score) VALUES
  (1, 1, 'SPEAKER_00', 'Alice', '[1,0]', 'eres2net-large-zh-cn', 1, NULL, NULL),
  (2, 1, 'SPEAKER_01', 'Speaker 2', '[0,1]', 'eres2net-large-zh-cn', NULL, 2, 0.55),
  (3, 2, 'SPEAKER_00', 'Bob', '[0,1]', 'eres2net-large-zh-cn', 2, NULL, NULL);
INSERT INTO voiceprints(id, person_id, speaker_id, embedding, emb_model) VALUES(1, 1, 1, '[1,0]', 'eres2net-large-zh-cn'), (2, 2, 3, '[0,1]', 'eres2net-large-zh-cn');
INSERT INTO segments(recording_id, start_ms, end_ms, speaker_id, text_raw) VALUES(1, 0, 1000, 1, 'hi'), (1, 1000, 2000, 2, 'yo');
INSERT INTO summaries(recording_id, template_id, language, status, content_md) VALUES(1, 'meeting', 'zh-TW', 'done', '# s');
INSERT INTO asks(question, status) VALUES('q?', 'done');
INSERT INTO settings(key, value) VALUES('about', '\"me\"'), ('me', '1');
INSERT INTO push_subscriptions(endpoint, p256dh, auth) VALUES('https://push.example/1', 'k', 'a');
INSERT INTO vocab_scans(from_id, to_id, status) VALUES(1, 1, 'done');
INSERT INTO vocab_suggestions(term, misheard, status) VALUES('Kiroku', '[\"Kiraku\"]', 'new');
INSERT INTO runners(name) VALUES('mac');"; } > "$dir/base.sql"
sql --file "$dir/base.sql"

# one query: row count of every table + every person link (speakers) + every voiceprint
state="SELECT 'count' AS k, json_object($(for t in recordings folders speakers segments people voiceprints summaries asks settings \
  push_subscriptions vocab_scans vocab_suggestions runners; do printf "'%s', (SELECT count(*) FROM %s), " $t $t; done | sed 's/, $//')) AS v
  UNION ALL SELECT 'speaker', json_object('id', id, 'person', person_id, 'suggest', suggest_person_id) FROM speakers
  UNION ALL SELECT 'print', json_object('id', id, 'person', person_id, 'speaker', speaker_id) FROM voiceprints"
before=$(q "$state")

sql --file migrations/0011_users.sql
after=$(q "$state")
case "$before" in *runners*speaker*print*) ;; *) echo "fixture not loaded: $before"; exit 1 ;; esac

fail=0
[ "$before" = "$after" ] || { echo "rows changed:"; echo " before: $before"; echo " after:  $after"; fail=1; }
owners=$(q "SELECT (SELECT count(*) FROM recordings WHERE user_id<>1) + (SELECT count(*) FROM people WHERE user_id<>1)
  + (SELECT count(*) FROM settings WHERE user_id<>1) + (SELECT count(*) FROM vocab_suggestions WHERE user_id<>1) AS n")
[ "$owners" = '[{"n":0}]' ] || { echo "rows not owned by user 1: $owners"; fail=1; }
[ "$(q "SELECT id, clerk_id FROM users")" = '[{"id":1,"clerk_id":null}]' ] || { echo "users seed wrong"; fail=1; }
# per-user uniqueness: user 2 may reuse user 1's names; user 1 still may not
sql --command "INSERT INTO users(clerk_id) VALUES('user_x'); INSERT INTO people(name, user_id) VALUES('Alice', 2);
  INSERT INTO settings(user_id, key, value) VALUES(2, 'about', '\"x\"'); INSERT INTO vocab_suggestions(user_id, term) VALUES(2, 'Kiroku');
  INSERT INTO folders(name, user_id) VALUES('Work', 2);"
if sql --command "INSERT INTO people(name) VALUES('Alice')" 2>/dev/null; then echo "people(user_id, name) not unique"; fail=1; fi
if sql --command "INSERT INTO folders(name) VALUES('Work')" 2>/dev/null; then echo "folders_name not unique per user"; fail=1; fi
[ "$fail" = 0 ] && echo "migrate ok"
exit "$fail"
