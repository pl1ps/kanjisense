import os
import json
from datetime import date, timedelta
from antigravity import Agent, tool
import google.generativeai as genai
from google.api_core import retry as garetry
from google.api_core import exceptions as gexceptions
from db import SessionLocal, Flashcard, ReviewLog, User, DUE_LIMITS, DEFAULT_DUE_LIMIT
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Configure Gemini
api_key = os.getenv("GOOGLE_API_KEY")
if api_key:
    genai.configure(api_key=api_key)

model_flash = genai.GenerativeModel('gemini-2.5-flash')

# Two kinds of error need OPPOSITE handling:
#   * 503 ServiceUnavailable / 500 / DeadlineExceeded = Google's servers are
#     momentarily overloaded. These are transient and usually clear on the next
#     attempt, so retrying (with backoff) is exactly the right remedy.
#   * 429 ResourceExhausted = WE hit the free tier's 5-requests/minute quota.
#     Retrying that only burns more of the allowance, so we must NOT retry it.
# So: retry the transient server errors, never the quota error.
def _retry_if_transient_not_quota(exc):
    return isinstance(exc, (
        gexceptions.ServiceUnavailable,   # 503 "model experiencing high demand"
        gexceptions.InternalServerError,  # 500
        gexceptions.DeadlineExceeded,     # 504 / gRPC deadline
    ))

# deadline=90 keeps the whole retry loop comfortably under gunicorn's 120s worker
# timeout, so the worker is never killed mid-retry.
_OCR_RETRY = garetry.Retry(
    predicate=_retry_if_transient_not_quota,
    initial=2.0, maximum=20.0, multiplier=2.0, deadline=90.0,
)

@tool(description="Extract Japanese vocabulary from an uploaded image or PDF page using Gemini Vision (Free).")
def ocr_scan_image(image_base64: str) -> list[dict]:
    # In Gemini, we pass the base64 data directly or as bytes
    import base64
    image_data = base64.b64decode(image_base64)
    
    prompt = (
        "Extract all Japanese vocabulary from this image. "
        "Return a JSON array where each item has: "
        "kanji (str - use kanji if the word contains kanji, otherwise use hiragana/katakana), "
        "reading (hiragana str), "
        "meaning (English str), "
        "example_sentence (Japanese str). Only return the JSON array."
    )
    
    try:
        response = model_flash.generate_content(
            [prompt, {"mime_type": "image/jpeg", "data": image_data}],
            request_options={"retry": _OCR_RETRY},
        )
    except gexceptions.ResourceExhausted:
        # 429: free tier = 5 requests/minute. Surface a friendly, actionable
        # message instead of the raw quota dump.
        raise RuntimeError(
            "Gemini's free tier allows only 5 scans per minute. "
            "Please wait about a minute and try again."
        )
    except gexceptions.ServiceUnavailable:
        # 503: Google's servers are overloaded even after our retries gave up.
        raise RuntimeError(
            "Gemini is experiencing high demand right now. "
            "Please wait a moment and try scanning again."
        )

    # Clean up the response (Gemini sometimes adds markdown code blocks)
    text = response.text.strip()
    if text.startswith("```json"):
        text = text[7:-3]
    elif text.startswith("```"):
        text = text[3:-3]
    
    return json.loads(text)

@tool(description="Save a new flashcard to the database, linked to a chapter and owner.")
def create_flashcard(
    kanji: str,
    reading: str,
    meaning: str,
    example_sentence: str,
    image_url: str,
    chapter: str,
    user_id: int
) -> dict:
    db = SessionLocal()
    card = Flashcard(
        user_id=user_id,
        kanji=kanji,
        reading=reading,
        meaning=meaning,
        example_sentence=example_sentence,
        image_url=image_url,
        chapter=chapter,
        ease_factor=2.5,
        interval=1,
        repetitions=0,
        next_review=date.today(),
    )
    db.add(card)
    db.commit()
    db.refresh(card)
    db.close()
    return {"id": card.id, "kanji": kanji, "chapter": chapter}

@tool(description="Apply the SM-2 spaced repetition algorithm to schedule a card's next review.")
def schedule_review(card_id: int, quality: int, user_id: int) -> dict:
    """quality: 0-5 (0=total blackout, 5=perfect recall)"""
    db = SessionLocal()
    card = db.query(Flashcard).filter_by(id=card_id, user_id=user_id).first()
    if card is None:
        db.close()
        return {"error": "Card not found", "card_id": card_id}

    # SM-2 algorithm
    if quality >= 3:
        if card.repetitions == 0:
            card.interval = 1
        elif card.repetitions == 1:
            card.interval = 6
        else:
            card.interval = round(card.interval * card.ease_factor)
        card.repetitions += 1
    else:
        card.repetitions = 0
        card.interval = 1

    card.ease_factor = max(1.3, card.ease_factor + 0.1 - (5 - quality) * 0.08)
    card.next_review = date.today() + timedelta(days=card.interval)

    # Extract values before committing and closing to avoid DetachedInstanceError
    next_review_val = str(card.next_review)
    interval_val = card.interval

    # Record review result in ReviewLog
    log = ReviewLog(
        user_id=user_id,
        card_id=card_id,
        correct=(quality >= 3),
        quality=quality,
        reviewed_at=date.today()
    )
    db.add(log)

    db.commit()
    db.close()
    return {"card_id": card_id, "next_review": next_review_val, "interval_days": interval_val}

@tool(description="Retrieve all flashcards for a specific chapter and owner, sorted by next review date.")
def get_chapter_cards(chapter: str, user_id: int) -> list[dict]:
    db = SessionLocal()
    cards = (
        db.query(Flashcard)
        .filter_by(chapter=chapter, user_id=user_id)
        .order_by(Flashcard.next_review)
        .all()
    )
    result = [
        {
            "id": c.id, "kanji": c.kanji, "reading": c.reading,
            "meaning": c.meaning, "image_url": c.image_url,
            "next_review": str(c.next_review),
        }
        for c in cards
    ]
    db.close()
    return result

def _card_dict(c) -> dict:
    return {
        "id": c.id, "kanji": c.kanji, "reading": c.reading,
        "meaning": c.meaning, "image_url": c.image_url,
        "example_sentence": c.example_sentence,
        "next_review": str(c.next_review),
    }

@tool(description="Retrieve a user's previously-reviewed flashcards that are due today, capped at their daily limit.")
def get_due_cards(user_id: int) -> list[dict]:
    db = SessionLocal()
    # Only cards the user has reviewed at least once before (new cards are learned
    # via the chapter Dashboard, not the daily due queue).
    reviewed_ids = (
        db.query(ReviewLog.card_id)
        .filter(ReviewLog.user_id == user_id)
        .distinct()
        .subquery()
    )
    user = db.query(User).get(user_id)
    pref = user.due_limit if (user and user.due_limit in DUE_LIMITS) else DEFAULT_DUE_LIMIT
    limit = DUE_LIMITS[pref]
    cards = (
        db.query(Flashcard)
        .filter(
            Flashcard.user_id == user_id,
            Flashcard.next_review <= date.today(),
            Flashcard.id.in_(reviewed_ids),
        )
        .order_by(Flashcard.next_review)
        .limit(limit)
        .all()
    )
    result = [_card_dict(c) for c in cards]
    db.close()
    return result

@tool(description="Retrieve a user's weakest flashcards (lowest review accuracy) across all chapters.")
def get_weak_cards(user_id: int) -> list[dict]:
    db = SessionLocal()
    logs = db.query(ReviewLog).filter_by(user_id=user_id).all()

    # Tally accuracy per card
    accuracy = {}
    for log in logs:
        stats = accuracy.setdefault(log.card_id, {"correct": 0, "total": 0})
        stats["total"] += 1
        if log.correct:
            stats["correct"] += 1

    # Weak = reviewed at least twice with under 60% accuracy
    weak = [
        (cid, s["correct"] / s["total"])
        for cid, s in accuracy.items()
        if s["total"] >= 2 and s["correct"] / s["total"] < 0.6
    ]
    weak.sort(key=lambda x: x[1])  # lowest accuracy first
    weak_ids = [cid for cid, _ in weak[:20]]

    cards_by_id = {
        c.id: c for c in db.query(Flashcard)
        .filter(Flashcard.id.in_(weak_ids), Flashcard.user_id == user_id)
        .all()
    }
    # Preserve the accuracy ordering
    result = [_card_dict(cards_by_id[cid]) for cid in weak_ids if cid in cards_by_id]
    db.close()
    return result

kanjisense_agent = Agent(
    name="KanjiSense",
    model="gemini-2.5-flash",  # Switched to Gemini 2.5 Flash
    system="""
    You are KanjiSense, an adaptive Japanese vocabulary tutor.
    You help learners build flashcards, analyse their weak points,
    and schedule personalised review sessions using spaced repetition.
    Always respond with structured JSON when calling tools.
    """,
    tools=[
        ocr_scan_image,
        create_flashcard,
        schedule_review,
        get_chapter_cards,
        get_due_cards,
        get_weak_cards,
    ]
)
