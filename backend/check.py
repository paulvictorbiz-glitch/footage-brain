from app.db.session import get_db
from app.db.models import IngestJob

with get_db() as s:
    for stage in ['transcript', 'embed']:
        pending = s.query(IngestJob).filter_by(stage=stage, status='pending').count()
        processing = s.query(IngestJob).filter_by(stage=stage, status='processing').count()
        done = s.query(IngestJob).filter_by(stage=stage, status='done').count()
        print(f'{stage}: pending={pending} processing={processing} done={done}')