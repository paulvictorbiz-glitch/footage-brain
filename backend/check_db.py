import sqlite3
conn = sqlite3.connect('footage_brain.db')
tables = conn.execute("""SELECT name FROM sqlite_master WHERE type='table'""").fetchall()
print([t[0] for t in tables])
rows = conn.execute('SELECT id, path, label, enabled FROM scan_roots ORDER BY created_at').fetchall()
for r in rows:
    print(r)
conn.close()
