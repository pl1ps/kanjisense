# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KanjiSense is an adaptive Japanese vocabulary flashcard tutor. It OCRs textbook pages into flashcards, generates illustrations, and schedules reviews with the SM-2 spaced-repetition algorithm. All code lives at the repository root (the project was flattened from an earlier `kanjisense/` subfolder layout).

## Commands

```bash
# from the repository root
pip install -r requirements.txt
python app.py            # serves API + frontend on http://127.0.0.1:5000 (debug=True)
```

There are no tests, linters, or build steps. The SQLite DB (`kanjisense.db`) is created automatically on first import of `db.py`.

`.env` (at the repo root, loaded via python-dotenv) needs two values: `GOOGLE_API_KEY` (Gemini) and `GOOGLE_CLIENT_ID` (a Google OAuth 2.0 "Web application" client id for Sign-in with Google). For the client id, add `http://127.0.0.1:5000` and `http://127.0.0.1:5500` as Authorized JavaScript origins in Google Cloud Console. Without a real `GOOGLE_CLIENT_ID` the login screen shows a "not configured" message and the app is unusable (login is required).

## Source-of-truth caveats

- The reasoning/OCR model is **Google Gemini 2.5 Flash** (`google-generativeai`, `GOOGLE_API_KEY`). There is no Anthropic/OpenAI usage despite any older references.
- `.clinerules` and `.cursorrules` are identical and describe the architecture. The live agent tools are `ocr_scan_image`, `create_flashcard`, `schedule_review`, `get_chapter_cards`, `get_due_cards`, `get_weak_cards`. Two key rules: keep using the `antigravity` framework rather than standard LLM chains, and always commit + close SQLAlchemy sessions in every tool/route to avoid session leaks.

## Architecture

Three-layer Flask app: `app.py` (HTTP) → `antigravity.run_agent` (dispatcher) → `agent.py` tools → `db.py` (SQLite/SQLAlchemy).

**The critical thing to understand: `run_agent` in `antigravity.py` is NOT a real LLM agent loop.** Despite building a tools prompt, it routes work by **substring-matching the task string** ("Scan this image", "Build a review session", "Record review result", "Get all flashcards") to a hard-coded sequence of direct tool calls. The Gemini LLM is only invoked inside `ocr_scan_image` and as a generic fallback for unmatched tasks. Consequences:

- `app.py` routes phrase their `task=` strings to deliberately hit these magic substrings — **changing that wording silently breaks routing**.
- The review-session path hard-codes `weak_count: 0`; there is no adaptive-weakness analysis (the tool that did it was removed as never-invoked dead code).

`antigravity.py` is a local stub (`Agent` class, `@tool` decorator, `run_agent`) — not the PyPI `antigravity` package (which was removed from requirements.txt since the local file shadows it anyway).

### Authentication (per-user data)
Google Sign-In, token-based (cookies are avoided because CORS uses `Access-Control-Allow-Origin: *` for the cross-port Live Server setup). Flow: frontend renders the GIS button → user signs in → Google returns an ID token (credential) → `POST /auth/google` verifies it with `google-auth` against `GOOGLE_CLIENT_ID`, upserts a `User`, and issues an opaque session token stored in the `sessions` table. The frontend keeps that token in `localStorage` and sends it as `Authorization: Bearer <token>` on every data request; `require_auth` in `app.py` resolves it to `g.user`. All flashcard/review routes are scoped to `g.user.id`.

**First-login data claim:** the first user to ever sign in adopts all pre-existing (unowned) flashcards and all review logs (`_claim_legacy_data` in `app.py`). This is a one-time migration of the legacy single-user data.

### Data model (`db.py`)
- `User`: `google_sub` (stable Google id), `email`, `name`, `due_limit` (`low`/`medium`/`high`, default `medium` — daily Review-Due cap, see `DUE_LIMITS` in `db.py`). `Session`: opaque bearer `token` → `user_id`.
- `Flashcard`: `user_id` (owner; NULL = unclaimed legacy) + vocab fields (`kanji`, `reading`, `meaning`, `example_sentence`, `image_url`, `chapter`) + SM-2 state (`ease_factor`, `interval`, `repetitions`, `next_review`).
- `ReviewLog`: per-review record (`user_id`, `card_id`, `correct`, `quality` 0–5, `reviewed_at`).
- `WateringLog`: one row per day a user waters their garden (`user_id`, `watered_on`). Cumulative row count drives tree growth and is never decremented.
- `db.py` runs `run_migrations()` on import — an in-place `ALTER TABLE flashcards ADD COLUMN user_id` for older DBs, since `create_all()` only adds missing tables, never columns.
- SM-2 scheduling lives in `schedule_review` (`agent.py`), which now also verifies the card belongs to the requesting user. Note the pattern of reading attribute values into locals before `db.close()` to dodge `DetachedInstanceError`.

`user_id` is threaded from `app.py` (`g.user.id`) → `run_agent` `context['user_id']` → the `create_flashcard` / `get_chapter_cards` / `schedule_review` tool calls.

### Frontend (`frontend/`)
Vanilla JS/CSS/HTML served by Flask. `review.js` resolves the backend URL dynamically: empty string when served from port 5000, else `http://127.0.0.1:5000` (so VS Code Live Server on 5500 still reaches the API — CORS is wide open via `after_request`). `#login-overlay` gates `#app` until `initAuth()` confirms a valid session; `authedFetch` attaches the bearer token and forces re-login on a `401`.

### API endpoints (`app.py`)
- Auth: `GET /auth/config` (exposes the public client id), `POST /auth/google` (verify + issue token), `GET /auth/me` (returns `name` + `due_limit`), `POST /auth/logout`.
- Data (all require `Authorization: Bearer` via `require_auth`, scoped to the user): `POST /scan`, `GET /chapters`, `GET /garden`, `POST /garden/water`, `POST /settings`, `GET /review/session`, `GET /review/due`, `GET /review/weak`, `POST /review/submit`, `GET /chapter/<name>`, `POST /chapter/<name>/rename`, `DELETE /chapter/<name>`.
- `/review/due` serves **only previously-reviewed cards** that are due (`next_review <= today` AND ≥1 `ReviewLog`), capped at the user's `due_limit` — brand-new cards are learned via the chapter Dashboard, not the daily queue. `/review/weak` (lowest-accuracy cards, `total>=2` reviews and `<60%`) also goes through `run_agent`; both return the same `{cards, weak_count}` shape as `/review/session`, so the frontend reuses the flashcard reviewer. `POST /settings` updates the user's `name` and `due_limit`. Sidebar items: Dashboard (chapters), Review Due Today, My Garden (`#section-stats`), Weak Cards, and Settings (`#section-settings`, below Scan & Create).
- **My Garden** (`GET /garden`, `POST /garden/water`) is the gamified progress view (direct DB queries via `_compute_garden`, bypassing `run_agent`). Tree stage comes from cumulative *watering days* (`WateringLog`, never shrinks); the sun is the study streak (consecutive `ReviewLog` days, may reset); flowers = mastery ratio capped by stage. `POST /garden/water` adds at most one `WateringLog` per day and only when `water_available` (reviewed today, not already watered, and either today's due queue is cleared or the daily review goal `due_limit` is met) — re-checked server-side. The tree wilts (render-only) after `GARDEN_WILT_AFTER` unwatered days but never loses a stage. Stage thresholds/flower caps live in `GARDEN_STAGES`/`GARDEN_FLOWER_CAPS` in `app.py` and are mirrored in `STAGE_THRESHOLDS` in `review.js`.
- Mutating routes handle `OPTIONS` for CORS preflight; `require_auth` also short-circuits `OPTIONS` so preflight never 401s.
- Static assets: the SPA is served from `frontend/`, but background images + the logo/favicon live in the sibling `images/` folder, served by the dedicated `GET /images/<filename>` route. CSS/HTML reference them with the relative `../images/...` path so they resolve under both Flask (:5000) and VS Code Live Server (:5500).
