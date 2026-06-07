import os
import secrets
from datetime import date, timedelta
from functools import wraps

from flask import Flask, request, jsonify, send_from_directory, g
from dotenv import load_dotenv
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

from antigravity import run_agent
from agent import kanjisense_agent
from db import (
    SessionLocal, User, Session as AuthSession, Flashcard, ReviewLog, WateringLog,
    DUE_LIMITS, DEFAULT_DUE_LIMIT,
)

load_dotenv()

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")

app = Flask(__name__, static_folder='frontend')

@app.after_request
def add_cors_headers(response):
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
    response.headers.add("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
    return response


# ----------------------------------------------------------------------------
# Authentication
# ----------------------------------------------------------------------------
def _claim_legacy_data(db, user_id):
    """The first user to ever sign in adopts all pre-existing (unowned) cards
    and review logs, per the project's chosen migration strategy."""
    db.query(Flashcard).filter(Flashcard.user_id.is_(None)).update(
        {Flashcard.user_id: user_id}, synchronize_session=False
    )
    db.query(ReviewLog).update({ReviewLog.user_id: user_id}, synchronize_session=False)


def _current_user():
    """Resolve the bearer token on the request to a User, or None."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):].strip()
    if not token:
        return None
    db = SessionLocal()
    try:
        sess = db.query(AuthSession).filter_by(token=token).first()
        if not sess:
            return None
        return db.query(User).get(sess.user_id)
    finally:
        db.close()


def require_auth(view):
    """Gate a route behind a valid session; stashes the user on flask.g."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if request.method == "OPTIONS":
            return "", 200
        user = _current_user()
        if user is None:
            return jsonify({"error": "Authentication required"}), 401
        g.user = user
        return view(*args, **kwargs)
    return wrapper


@app.route("/auth/config", methods=["GET"])
def auth_config():
    """Expose the public OAuth client id so the frontend has a single source of truth."""
    return jsonify({"client_id": GOOGLE_CLIENT_ID})


@app.route("/auth/google", methods=["POST", "OPTIONS"])
def auth_google():
    """Verify a Google ID token (credential) and issue an app session token."""
    if request.method == "OPTIONS":
        return "", 200
    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "Server is missing GOOGLE_CLIENT_ID"}), 500

    data = request.json or {}
    credential = data.get("credential")
    if not credential:
        return jsonify({"error": "Missing credential"}), 400

    try:
        idinfo = id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except ValueError:
        return jsonify({"error": "Invalid Google token"}), 401

    google_sub = idinfo["sub"]
    email = idinfo.get("email", "")
    name = idinfo.get("name", "") or email

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(google_sub=google_sub).first()
        if user is None:
            is_first_user = db.query(User).count() == 0
            user = User(google_sub=google_sub, email=email, name=name)
            db.add(user)
            db.commit()
            db.refresh(user)
            if is_first_user:
                _claim_legacy_data(db, user.id)
                db.commit()
        else:
            # Keep profile fields fresh
            user.email = email
            user.name = name
            db.commit()

        token = secrets.token_urlsafe(32)
        db.add(AuthSession(token=token, user_id=user.id))
        db.commit()

        return jsonify({
            "token": token,
            "user": {"email": user.email, "name": user.name},
        })
    finally:
        db.close()


@app.route("/auth/me", methods=["GET"])
@require_auth
def auth_me():
    return jsonify({"user": {
        "email": g.user.email,
        "name": g.user.name,
        "due_limit": g.user.due_limit or DEFAULT_DUE_LIMIT,
    }})


@app.route("/settings", methods=["POST", "OPTIONS"])
@require_auth
def update_settings():
    """Update the user's display name and daily due-card limit."""
    data = request.json or {}
    db = SessionLocal()
    try:
        user = db.query(User).get(g.user.id)
        name = (data.get("name") or "").strip()
        if name:
            user.name = name
        due_limit = data.get("due_limit")
        if due_limit in DUE_LIMITS:
            user.due_limit = due_limit
        db.commit()
        return jsonify({"name": user.name, "due_limit": user.due_limit})
    finally:
        db.close()


@app.route("/auth/logout", methods=["POST", "OPTIONS"])
def auth_logout():
    if request.method == "OPTIONS":
        return "", 200
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer "):].strip()
        db = SessionLocal()
        try:
            db.query(AuthSession).filter_by(token=token).delete()
            db.commit()
        finally:
            db.close()
    return jsonify({"status": "logged_out"})


# ----------------------------------------------------------------------------
# Static frontend
# ----------------------------------------------------------------------------
IMAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'images')

@app.route("/")
def index():
    return send_from_directory('frontend', 'index.html')

@app.route("/images/<path:filename>")
def images(filename):
    """Serve backgrounds/logo from the sibling images/ folder (not under frontend/)."""
    return send_from_directory(IMAGES_DIR, filename)

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory('frontend', path)


# ----------------------------------------------------------------------------
# Flashcard API (all scoped to the logged-in user)
# ----------------------------------------------------------------------------
@app.route("/scan", methods=["POST", "OPTIONS"])
@require_auth
def scan():
    """Upload image → agent OCRs and creates cards for the current user."""
    try:
        data = request.json
        if not data or 'image_base64' not in data or 'chapter' not in data:
            return jsonify({"error": "Missing image or chapter data"}), 400

        result = run_agent(kanjisense_agent, task=(
            f"Scan this image and create flashcards for chapter '{data['chapter']}'. "
            f"Image (base64): {data['image_base64'][:40]}..."
        ), context={**data, "user_id": g.user.id})
        return jsonify(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/chapters", methods=["GET"])
@require_auth
def get_chapters():
    """Get this user's chapters, each with card count and latest review score."""
    from sqlalchemy import func
    db = SessionLocal()
    user_id = g.user.id

    # 1. Get this user's chapters and their card count
    results = (
        db.query(Flashcard.chapter, func.count(Flashcard.id))
        .filter(Flashcard.user_id == user_id)
        .group_by(Flashcard.chapter)
        .all()
    )

    chapters = []
    for r in results:
        chapter_name = r[0] if r[0] else "Uncategorized"
        total_count = r[1]

        # Get all card IDs for this chapter (this user's only)
        cards = (
            db.query(Flashcard.id)
            .filter(Flashcard.chapter == chapter_name, Flashcard.user_id == user_id)
            .all()
        )
        card_ids = [c[0] for c in cards]

        # Get the latest review log ID for each card in this chapter
        latest_log_ids = (
            db.query(func.max(ReviewLog.id))
            .filter(ReviewLog.card_id.in_(card_ids))
            .group_by(ReviewLog.card_id)
            .all()
        )
        latest_ids = [l[0] for l in latest_log_ids if l[0] is not None]

        remembered_count = 0
        if latest_ids:
            # Count how many of these latest reviews are correct
            remembered_count = (
                db.query(ReviewLog)
                .filter(ReviewLog.id.in_(latest_ids), ReviewLog.correct == True)
                .count()
            )

        score_percent = int((remembered_count / total_count) * 100) if total_count > 0 else 0

        chapters.append({
            "name": chapter_name,
            "card_count": total_count,
            "remembered_count": remembered_count,
            "score_percent": score_percent
        })

    db.close()
    return jsonify({"chapters": chapters})

# ----------------------------------------------------------------------------
# Knowledge Garden — gamified progress view
# ----------------------------------------------------------------------------
# Tree size grows from cumulative watering days (never shrinks); the sun is the
# study streak (allowed to reset); flowers reflect mastery; the tree wilts as a
# gentle nudge after a few unwatered days.
GARDEN_STAGES = [(0, "seed"), (1, "sprout"), (5, "sapling"), (15, "young_tree"), (30, "mighty_tree")]
GARDEN_FLOWER_CAPS = {"sapling": 3, "young_tree": 6, "mighty_tree": 12}
GARDEN_WILT_AFTER = 3  # days since last watering before the tree droops

def _compute_garden(db, user_id):
    """Return the full garden scene state for a user (single source of truth)."""
    today = date.today()

    total_cards = db.query(Flashcard).filter(Flashcard.user_id == user_id).count()
    mastered = (
        db.query(Flashcard)
        .filter(Flashcard.user_id == user_id, Flashcard.repetitions >= 3)
        .count()
    )
    # "Due" mirrors the Review Due Today queue: previously-reviewed cards only.
    reviewed_ids = (
        db.query(ReviewLog.card_id).filter(ReviewLog.user_id == user_id).distinct().subquery()
    )
    due_today = (
        db.query(Flashcard)
        .filter(
            Flashcard.user_id == user_id,
            Flashcard.next_review <= today,
            Flashcard.id.in_(reviewed_ids),
        )
        .count()
    )
    reviews_today = (
        db.query(ReviewLog)
        .filter(ReviewLog.user_id == user_id, ReviewLog.reviewed_at == today)
        .count()
    )

    user = db.query(User).get(user_id)
    pref = user.due_limit if (user and user.due_limit in DUE_LIMITS) else DEFAULT_DUE_LIMIT
    daily_limit = DUE_LIMITS[pref]

    # Study streak (sun): consecutive review days ending today, with a one-day
    # grace so "haven't studied yet today" doesn't read as a broken streak.
    review_dates = {
        r[0] for r in db.query(ReviewLog.reviewed_at)
        .filter(ReviewLog.user_id == user_id).distinct().all()
        if r[0] is not None
    }
    streak_days = 0
    day = today
    if day not in review_dates and (day - timedelta(days=1)) in review_dates:
        day = day - timedelta(days=1)
    while day in review_dates:
        streak_days += 1
        day -= timedelta(days=1)

    # Watering (tree): cumulative distinct days watered.
    watering_dates = {
        r[0] for r in db.query(WateringLog.watered_on)
        .filter(WateringLog.user_id == user_id).distinct().all()
        if r[0] is not None
    }
    watering_days = len(watering_dates)
    watered_today = today in watering_dates
    days_since_water = (today - max(watering_dates)).days if watering_dates else None

    # Stage (highest threshold reached) + progress toward the next stage.
    stage_index = 0
    stage = GARDEN_STAGES[0][1]
    for i, (threshold, name) in enumerate(GARDEN_STAGES):
        if watering_days >= threshold:
            stage_index, stage = i, name
    next_stage_at = GARDEN_STAGES[stage_index + 1][0] if stage_index + 1 < len(GARDEN_STAGES) else None

    cap = GARDEN_FLOWER_CAPS.get(stage, 0)
    flowers = round(mastered / total_cards * cap) if (total_cards and cap) else 0

    # Water once today's due queue is cleared OR the daily review goal is met.
    water_available = (
        (not watered_today)
        and (reviews_today > 0)
        and (due_today == 0 or reviews_today >= daily_limit)
    )
    wilting = watering_days > 0 and days_since_water is not None and days_since_water > GARDEN_WILT_AFTER

    return {
        "stage": stage,
        "stage_index": stage_index,
        "watering_days": watering_days,
        "next_stage_at": next_stage_at,
        "streak_days": streak_days,
        "mastered": mastered,
        "total_cards": total_cards,
        "due_today": due_today,
        "flowers": flowers,
        "water_available": water_available,
        "watered_today": watered_today,
        "days_since_water": days_since_water,
        "wilting": wilting,
    }

@app.route("/garden", methods=["GET"])
@require_auth
def garden():
    """Current state of the user's knowledge garden."""
    db = SessionLocal()
    try:
        return jsonify(_compute_garden(db, g.user.id))
    finally:
        db.close()

@app.route("/garden/water", methods=["POST", "OPTIONS"])
@require_auth
def garden_water():
    """Water the garden once for today (only if today's due cards are cleared)."""
    db = SessionLocal()
    try:
        user_id = g.user.id
        before = _compute_garden(db, user_id)
        if not before["water_available"]:
            reason = "already_watered" if before["watered_today"] else "cards_due"
            return jsonify({"watered": False, "reason": reason, **before})

        db.add(WateringLog(user_id=user_id, watered_on=date.today()))
        db.commit()

        after = _compute_garden(db, user_id)
        grew = after["stage_index"] > before["stage_index"]
        return jsonify({"watered": True, "grew": grew, **after})
    finally:
        db.close()

@app.route("/review/session", methods=["GET"])
@require_auth
def review_session():
    """Agent builds an adaptive review session for today, for the current user."""
    user_id = g.user.id
    chapter = request.args.get("chapter", "")
    result = run_agent(kanjisense_agent, task=(
        f"Build a review session for user {user_id} and chapter '{chapter}'."
    ), context={"chapter": chapter, "user_id": user_id})
    return jsonify(result)

@app.route("/review/due", methods=["GET"])
@require_auth
def review_due():
    """Cards due today or earlier for the current user, across all chapters."""
    result = run_agent(
        kanjisense_agent,
        task="Build a due review session for the current user.",
        context={"user_id": g.user.id},
    )
    return jsonify(result)

@app.route("/review/weak", methods=["GET"])
@require_auth
def review_weak():
    """The current user's lowest-accuracy cards, across all chapters."""
    result = run_agent(
        kanjisense_agent,
        task="Build a weak review session for the current user.",
        context={"user_id": g.user.id},
    )
    return jsonify(result)

@app.route("/review/submit", methods=["POST", "OPTIONS"])
@require_auth
def submit_review():
    """Submit a review result and schedule next appearance."""
    data = request.json
    result = run_agent(kanjisense_agent, task=(
        f"Record review result for card {data['card_id']} "
        f"with quality score {data['quality']} and schedule its next review."
    ), context={"user_id": g.user.id})
    return jsonify(result)

@app.route("/chapter/<name>", methods=["GET"])
@require_auth
def chapter_cards(name):
    """Get all cards for a chapter belonging to the current user."""
    result = run_agent(
        kanjisense_agent,
        task=f"Get all flashcards for chapter '{name}'.",
        context={"user_id": g.user.id},
    )
    return jsonify(result)

@app.route("/chapter/<name>/rename", methods=["POST", "OPTIONS"])
@require_auth
def rename_chapter(name):
    """Rename a chapter (updates the chapter field for this user's flashcards in it)."""
    try:
        data = request.json
        new_name = data.get("new_name") if data else None
        if not new_name:
            return jsonify({"error": "Missing new_name"}), 400

        db = SessionLocal()
        updated = (
            db.query(Flashcard)
            .filter(Flashcard.chapter == name, Flashcard.user_id == g.user.id)
            .update({Flashcard.chapter: new_name}, synchronize_session=False)
        )
        db.commit()
        db.close()

        return jsonify({"status": "success", "updated": updated, "old_name": name, "new_name": new_name})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/chapter/<name>", methods=["DELETE", "OPTIONS"])
@require_auth
def delete_chapter(name):
    """Delete this user's cards (and their review logs) for a chapter."""
    try:
        db = SessionLocal()
        # Get card IDs to clean up review logs (this user's only)
        card_ids = [
            c.id for c in db.query(Flashcard.id)
            .filter(Flashcard.chapter == name, Flashcard.user_id == g.user.id)
            .all()
        ]
        if card_ids:
            db.query(ReviewLog).filter(ReviewLog.card_id.in_(card_ids)).delete(synchronize_session=False)
        deleted = (
            db.query(Flashcard)
            .filter(Flashcard.chapter == name, Flashcard.user_id == g.user.id)
            .delete(synchronize_session=False)
        )
        db.commit()
        db.close()
        return jsonify({"deleted": deleted, "chapter": name})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)
