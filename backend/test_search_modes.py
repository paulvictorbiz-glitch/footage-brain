import sys
import os

# Ensure the backend directory is in the python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.db.session import get_db
from app.search.engine import visual_search, caption_search, SearchFilters

def test_searches():
    queries = [
        "baby chickens in a cage",
        "children running",
        "train window landscape shot",
        "guys drunk and eating food"
    ]
    
    filters = SearchFilters()
    
    print("==========================================")
    print("Testing Visual (CLIP) vs Caption (VLM) Search")
    print("==========================================\n")
    
    with get_db() as session:
        for q in queries:
            print(f"QUERY: '{q}'")
            print("-" * 40)
            
            # Test Visual (CLIP) Search
            print("Mode: VISUAL (CLIP embeddings)")
            try:
                v_results = visual_search(session, q, filters, n_results=3, min_score=0.1)
                if not v_results:
                    print("  No results found.")
                else:
                    for i, r in enumerate(v_results):
                        print(f"  {i+1}. {r.filename} (Score: {r.best_score:.3f})")
                        for f in r.frame_matches[:2]:
                            print(f"     - Frame @ {f.timestamp}s (Score: {f.score:.3f})")
            except Exception as e:
                print(f"  Error: {e}")
                
            print("")
            
            # Test Caption (VLM) Search
            print("Mode: CAPTION (VLM generated captions)")
            try:
                c_results = caption_search(session, q, filters, n_results=3, min_score=0.1)
                if not c_results:
                    print("  No results found.")
                else:
                    for i, r in enumerate(c_results):
                        print(f"  {i+1}. {r.filename} (Score: {r.best_score:.3f})")
                        # Try to find the matching caption text from the db
                        for chunk in r.frame_matches[:2]:
                            from app.db.models import FrameCaption
                            fc = session.query(FrameCaption).filter_by(chroma_id=chunk.frame_id).first()
                            text = fc.caption if fc else "(No text found)"
                            print(f"     - Frame @ {chunk.timestamp}s (Score: {chunk.score:.3f}): {text}")
            except Exception as e:
                print(f"  Error: {e}")
                
            print("\n" + "="*40 + "\n")

if __name__ == "__main__":
    test_searches()
