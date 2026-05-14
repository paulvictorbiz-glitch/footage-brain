from app.db.session import get_db
from app.db.models import IngestJob

with get_db() as s:
    jobs = s.query(IngestJob).filter_by(stage='embed', status='failed').all()
    for j in jobs:
        j.status = 'pending'
        j.attempts = 0
        j.error_message = None
    s.commit()
    print(f'Reset {len(jobs)} jobs')
