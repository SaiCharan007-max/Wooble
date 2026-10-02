"""Caregiver-note signal extraction.

Turns free text into a small, fixed set of structured signals. The risk engine only ever
sees these structured signals - free text (or any future LLM output) can never set the
risk level directly, and anything outside the allowed vocabulary is discarded.
"""
import re

ALLOWED_SIGNALS = {
    "breathing_difficulty": "Breathing difficulty",
    "chest_discomfort": "Chest discomfort",
    "confusion": "Confusion",
    "dizziness": "Dizziness",
    "fatigue": "Fatigue",
    "reduced_appetite": "Reduced appetite",
    "pain": "Pain",
}

PATTERNS = {
    "breathing_difficulty": [r"difficulty (in )?breathing", r"short(ness)? of breath", r"breathless",
                             r"trouble breathing", r"struggling to breathe", r"breathing (fast|hard|heavily)",
                             r"can'?t breathe", r"wheez", r"gasping"],
    "chest_discomfort": [r"chest (pain|discomfort|tightness|pressure)", r"pain in (his|her|the) chest"],
    "confusion": [r"confus", r"disorient", r"not making sense", r"didn'?t recogni[sz]e", r"agitated"],
    "dizziness": [r"dizz", r"light-?headed", r"unsteady", r"vertigo"],
    "fatigue": [r"tired", r"fatigue", r"exhausted", r"letharg", r"weak(ness)?\b", r"drowsy", r"sleepy"],
    "reduced_appetite": [r"not eating", r"poor appetite", r"no appetite", r"reduced appetite", r"loss of appetite",
                         r"refus\w* (to eat|food|meals?|dinner|lunch|breakfast)", r"skipped (meals?|dinner|lunch|breakfast)",
                         r"ate (very )?little"],
    "pain": [r"\bpain\b", r"\bache\b", r"\bhurts?\b", r"\bsore\b"],
}

# Basic Hindi / Telugu keywords (bonus; English is the primary demo language).
MULTILINGUAL = {
    "breathing_difficulty": ["सांस लेने में तकलीफ", "सांस फूल", "ఆయాసం", "ఊపిరి ఆడటం లేదు"],
    "chest_discomfort": ["सीने में दर्द", "छाती में दर्द", "ఛాతీ నొప్పి"],
    "confusion": ["भ्रम", "उलझन", "అయోమయం"],
    "dizziness": ["चक्कर", "తల తిరుగు"],
    "fatigue": ["थकान", "कमजोरी", "అలసట", "నీరసం"],
    "reduced_appetite": ["भूख नहीं", "खाना नहीं", "ఆకలి లేదు"],
}

NEGATORS = {"no", "not", "denies", "denied", "without", "never", "nil", "negative"}


def detect_language(text):
    if re.search(r"[ఀ-౿]", text):
        return "te"
    if re.search(r"[ऀ-ॿ]", text):
        return "hi"
    return "en"


def _negated(text, start):
    """A negating word in the same clause, within the 4 preceding words."""
    clause_start = max(text.rfind(c, 0, start) for c in ".;!?\n,") + 1
    words = re.findall(r"[a-z']+", text[clause_start:start])[-4:]
    return any(w in NEGATORS or w.endswith("n't") for w in words)


def validate_signals(candidates):
    """Keep only known signals. Used for rule-based output and any future LLM extractor."""
    seen, out = set(), []
    for c in candidates:
        if c.get("signal") in ALLOWED_SIGNALS and c["signal"] not in seen:
            seen.add(c["signal"])
            out.append({"signal": c["signal"], "label": ALLOWED_SIGNALS[c["signal"]],
                        "evidence": str(c.get("evidence", ""))[:200]})
    return out


def extract(text):
    lower = text.lower()
    found, negated = [], []
    for signal, patterns in PATTERNS.items():
        for pat in patterns:
            m = re.search(pat, lower)
            if not m:
                continue
            item = {"signal": signal, "evidence": text[m.start():m.end()]}
            if _negated(lower, m.start()):
                negated.append(item)
            else:
                found.append(item)
                break
    for signal, words in MULTILINGUAL.items():
        for w in words:
            if w in text:
                found.append({"signal": signal, "evidence": w})
                break
    # "chest pain" should not also count as generic pain.
    if any(f["signal"] == "chest_discomfort" for f in found):
        found = [f for f in found if f["signal"] != "pain"]
    signals = validate_signals(found)
    found_ids = {s["signal"] for s in signals}
    negated = [n for n in validate_signals(negated) if n["signal"] not in found_ids]
    language = detect_language(text)
    return {
        "language": language,
        # Real translation needs an external model; the prototype keeps English as-is.
        "translated_text": text if language == "en" else None,
        "signals": signals,
        "negated_signals": negated,
        "method": "rule-based-v1",
    }
