"""
VLM-based image captioner — third multimodal stream alongside CLIP frame
embeddings and Whisper transcripts.

Generates short natural-language descriptions for sampled video frames so they
can be searched by visual content even when CLIP's joint space is too coarse
or when the user types language that doesn't map well to image features
(named entities, mood, edit-intent like "transition shot", etc.).

Default model is Salesforce/blip-image-captioning-base — ~990MB, no remote
code, ~0.3s/image on CPU. Configurable via CAPTIONER_MODEL. The loader
auto-detects the model architecture from the id so swapping to LLaVA or
Qwen2-VL works without code changes.

This module is laptop-aware:
  • Lazy-loaded — model weights only fault in on first caption call.
  • Auto-detects CUDA / Apple MPS / CPU.
  • Batched generation, configurable batch size.
  • Default disabled (settings.captioner_enabled=False); pipeline stage
    no-ops when disabled.
"""
from __future__ import annotations

from typing import List, Optional

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


_model = None
_processor = None
_device = None
_kind: Optional[str] = None
_loaded_model_name: Optional[str] = None


def _resolve_device(preference: str) -> str:
    import torch
    pref = (preference or "auto").lower()
    if pref == "cpu":
        return "cpu"
    if pref == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if pref == "mps":
        return "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _infer_kind(model_id: str) -> str:
    name = (model_id or "").lower()
    if "qwen2-vl" in name or "qwen2vl" in name:
        return "qwen2vl"
    if "llava" in name:
        return "llava"
    if "smolvlm" in name:
        return "smolvlm"
    return "blip"


def _get_model():
    global _model, _processor, _device, _kind, _loaded_model_name

    settings = get_settings()
    model_name = settings.captioner_model

    if _model is not None and _loaded_model_name == model_name:
        return _model, _processor, _device, _kind

    import torch
    from transformers import AutoProcessor

    _device = _resolve_device(settings.captioner_device)
    _kind = _infer_kind(model_name)
    logger.info("captioner_model_load", model=model_name, kind=_kind, device=_device)

    dtype = torch.float16 if _device in ("cuda", "mps") else torch.float32

    if _kind == "qwen2vl":
        from transformers import Qwen2VLForConditionalGeneration
        _model = Qwen2VLForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)
    elif _kind == "llava":
        from transformers import LlavaForConditionalGeneration
        _model = LlavaForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)
    elif _kind == "smolvlm":
        from transformers import AutoModelForVision2Seq
        _model = AutoModelForVision2Seq.from_pretrained(model_name, torch_dtype=dtype)
    else:
        from transformers import BlipForConditionalGeneration
        _model = BlipForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)

    _processor = AutoProcessor.from_pretrained(model_name)
    _model = _model.to(_device)
    _model.eval()
    _loaded_model_name = model_name
    logger.info("captioner_model_ready", model=model_name, kind=_kind, device=_device, dtype=str(dtype))
    return _model, _processor, _device, _kind


def caption_images(images: List) -> List[str]:
    """
    Caption a batch of PIL Images. Returns one caption string per image.
    Returns empty strings on per-image failure rather than raising.
    """
    if not images:
        return []
    import torch

    settings = get_settings()
    model, processor, device, kind = _get_model()

    captions: List[str] = []
    batch_size = max(1, int(settings.captioner_batch_size))
    max_new_tokens = max(8, int(settings.captioner_max_new_tokens))

    for start in range(0, len(images), batch_size):
        batch = images[start : start + batch_size]
        try:
            if kind in ("qwen2vl", "llava", "smolvlm"):
                prompt = "Describe this video frame in one short sentence."
                messages_batch = [
                    [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
                    for _ in batch
                ]
                try:
                    chat_texts = [
                        processor.apply_chat_template(m, add_generation_prompt=True)
                        for m in messages_batch
                    ]
                except Exception:
                    chat_texts = [prompt] * len(batch)
                inputs = processor(text=chat_texts, images=list(batch), return_tensors="pt", padding=True)
                inputs = {k: v.to(device) for k, v in inputs.items()}
                with torch.no_grad():
                    out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
                input_lens = inputs["input_ids"].shape[1]
                decoded = processor.batch_decode(out[:, input_lens:], skip_special_tokens=True)
            else:
                inputs = processor(images=batch, return_tensors="pt")
                inputs = {k: v.to(device) for k, v in inputs.items()}
                with torch.no_grad():
                    out = model.generate(
                        **inputs,
                        max_new_tokens=max_new_tokens,
                        num_beams=1,
                        do_sample=False,
                    )
                decoded = processor.batch_decode(out, skip_special_tokens=True)
            captions.extend(c.strip() for c in decoded)
        except Exception as exc:
            logger.error("captioner_batch_error", error=str(exc), batch_size=len(batch))
            captions.extend([""] * len(batch))

    return captions
