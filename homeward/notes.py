"""Caregiver-note understanding.

A transparent clinical lexicon, not a black-box model: every concern it finds is
returned with the exact phrase that triggered it, so a nurse can check the reasoning.

* English is fully supported, including negation ("no chest pain", "denies fever",
  "did not fall" are recognised as reassuring, not alarming).
* Basic Hindi and Telugu support (native script and common romanised words) is
  provided as a bonus for multilingual caregivers.
"""
import re

# (category, weight, red_flag, patterns). A red flag on its own makes risk HIGH.
CONCERNS = [
    ("chest pain", 3, True, [r"chest (pain|tightness|pressure)", r"pain in (his|her|the) chest",
                             r"pressure (in|on) (his|her|the) chest"]),
    ("severe breathing difficulty", 3, True, [r"can'?not breathe", r"can'?t breathe", r"gasping",
                                              r"(lips|face|fingers) (are |look |looks |turned |turning )?(blue|bluish|grey|gray)"]),
    ("unresponsive / collapse", 3, True, [r"unresponsive", r"not responding", r"won'?t wake", r"unconscious",
                                          r"passed out", r"faint(ed|ing)", r"collapsed"]),
    ("seizure", 3, True, [r"seizure", r"\bfits?\b", r"convuls"]),
    ("stroke signs", 3, True, [r"face (is )?droop", r"slurred speech", r"weakness (on|in) (one|the left|the right) side",
                               r"can'?t (move|lift) (his|her) (arm|leg)"]),
    ("breathlessness", 2, False, [r"short(ness)? of breath", r"breathless", r"difficulty breathing",
                                  r"struggling to breathe", r"breathing (fast|heavily|hard)", r"wheez"]),
    ("confusion", 2, False, [r"confus", r"disorient", r"not making sense", r"didn'?t recogni[sz]e",
                             r"agitated", r"delirious", r"talking nonsense"]),
    ("drowsiness", 2, False, [r"drowsy", r"very sleepy", r"hard to wake", r"letharg", r"sleeping (all|most of the) day"]),
    ("fall", 2, False, [r"\bfell\b(?! asleep)", r"\bfall(en)?\b(?! asleep)", r"slipped"]),
    ("reduced urine output", 2, False, [r"not passed urine", r"no urine", r"passing (less|little) urine",
                                        r"hasn'?t (passed urine|urinated|peed)", r"dark urine"]),
    ("bleeding", 2, False, [r"bleed", r"blood in"]),
    ("fever / chills", 1, False, [r"fever", r"chills", r"shiver", r"rigors", r"feels? (very )?hot", r"febrile"]),
    ("poor intake", 1, False, [r"not eating", r"refus\w* (to eat|food|meals?|dinner|lunch|breakfast|water)",
                               r"poor appetite", r"no appetite", r"not drinking", r"skipped (meals?|dinner|lunch|breakfast)"]),
    ("vomiting", 1, False, [r"vomit", r"throwing up"]),
    ("dizziness", 1, False, [r"dizz", r"light-?headed"]),
    ("swelling", 1, False, [r"swollen (legs|ankles|feet)", r"swelling"]),
    ("wound problem", 1, False, [r"wound (is |looks )?(red|hot|oozing|smelly|swollen)", r"\bpus\b",
                                 r"discharge from (the )?wound"]),
    ("missed medication", 1, False, [r"missed (his|her|the)? ?(medicine|medication|tablets?|dose)",
                                     r"refused (his|her|the)? ?(medicine|medication|tablets?)"]),
    ("pain", 1, False, [r"\bpain\b", r"\bache\b", r"hurts"]),
]

REASSURING = [r"(eating|ate) well", r"comfortable", r"good spirits", r"slept well", r"walking (well|around|independently)",
              r"no complaints", r"alert and (oriented|talking)", r"feeling better", r"improving", r"stable"]

NEGATORS = {"no", "not", "denies", "denied", "without", "never", "nil", "negative"}

# Bonus: a small native-script + romanised lexicon for Hindi and Telugu.
MULTILINGUAL = [
    ("chest pain", 3, True, ["सीने में दर्द", "छाती में दर्द", "ఛాతీ నొప్పి", "seene me dard", "chaati noppi"]),
    ("severe breathing difficulty", 3, True, ["सांस नहीं ले", "ఊపిరి ఆడటం లేదు", "saans nahi"]),
    ("unresponsive / collapse", 3, True, ["बेहोश", "స్పృహ లేదు", "స్పృహ తప్పి", "behosh"]),
    ("breathlessness", 2, False, ["सांस लेने में तकलीफ", "सांस फूल", "ఆయాసం", "saans phool", "aayasam"]),
    ("confusion", 2, False, ["भ्रम", "उलझन", "అయోమయం"]),
    ("fall", 2, False, ["गिर गए", "गिर गई", "పడిపోయారు", "padipoyaru", "gir gaye", "gir gayi"]),
    ("fever / chills", 1, False, ["बुखार", "జ్వరం", "bukhar", "jwaram"]),
    ("vomiting", 1, False, ["उल्टी", "వాంతులు", "vanthulu", "ulti"]),
    ("dizziness", 1, False, ["चक्कर", "కళ్ళు తిరుగు", "తల తిరుగు", "chakkar"]),
    ("poor intake", 1, False, ["खाना नहीं", "అన్నం తినడం లేదు", "khana nahi"]),
]


def detect_language(text):
    if re.search(r"[ఀ-౿]", text):
        return "te"
    if re.search(r"[ऀ-ॿ]", text):
        return "hi"
    return "en"


def _is_negated(text, start):
    """Look back within the same clause for a negating word, e.g. 'no fever', 'did not fall'."""
    clause_start = max(text.rfind(c, 0, start) for c in ".;!?\n,") + 1
    preceding = re.findall(r"[a-z']+", text[clause_start:start])[-4:]
    return any(w in NEGATORS or w.endswith("n't") for w in preceding)


def analyse_note(text):
    lower = text.lower()
    found, negated = {}, []

    for category, weight, red_flag, patterns in CONCERNS:
        for pat in patterns:
            for m in re.finditer(pat, lower):
                phrase = text[m.start():m.end()]
                if _is_negated(lower, m.start()):
                    negated.append({"category": category, "phrase": phrase})
                    continue
                found.setdefault(category, {"category": category, "weight": weight,
                                            "red_flag": red_flag, "phrase": phrase})
                break

    for category, weight, red_flag, words in MULTILINGUAL:
        for w in words:
            if w.lower() in lower:
                found.setdefault(category, {"category": category, "weight": weight,
                                            "red_flag": red_flag, "phrase": w})
                break

    # A specific finding makes the generic "pain" match redundant.
    if "pain" in found and "chest pain" in found:
        del found["pain"]

    reassuring = [m.group(0) for pat in REASSURING for m in [re.search(pat, lower)] if m]
    concerns = sorted(found.values(), key=lambda c: -c["weight"])
    raw = sum(c["weight"] for c in concerns)
    # Reassurance can soften minor concerns but never cancels a red flag.
    score = max(0, raw - len(reassuring))
    red_flags = [c["category"] for c in concerns if c["red_flag"]]

    return {
        "language": detect_language(text),
        "concerns": concerns,
        "negated": negated,
        "reassuring": reassuring,
        "score": score,
        "red_flags": red_flags,
    }
