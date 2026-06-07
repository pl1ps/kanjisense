# KanjiSense

An adaptive Japanese vocabulary flashcard tutor. Scan a textbook page, and KanjiSense uses **Google Gemini** to OCR the vocabulary into flashcards, then schedules reviews with the **SM-2** spaced-repetition algorithm. Each user signs in with Google and gets their own private decks, plus a gamified **"My Garden"** progress view.

## Features
- 📸 **Scan & Create** — OCR a textbook photo into flashcards (Gemini 2.5 Flash).
- 🔁 **Spaced repetition** — SM-2 scheduling; "Review Due Today" surfaces cards as they come due.
- 🌳 **My Garden** — a tree that grows as you keep up your reviews (sun = streak, flowers = mastery).
- 📊 **Weak Cards** — focused practice on your lowest-accuracy cards.
- 🔐 **Google Sign-In** — per-user decks and progress.
- ⚙️ **Settings** — display name + daily review load (Low / Medium / High).

## Tech stack
Flask · SQLAlchemy + SQLite · Google Gemini (`google-generativeai`) · Google Sign-In (`google-auth`) · vanilla JS/CSS frontend.

## Run locally
```bash
cd kanjisense
pip install -r requirements.txt
cp .env.example .env        # then fill in the two values below
python app.py               # http://127.0.0.1:5000
```

`.env` needs:
- `GOOGLE_API_KEY` — Gemini key from https://aistudio.google.com/apikey
- `GOOGLE_CLIENT_ID` — Google OAuth 2.0 "Web application" client id (https://console.cloud.google.com/apis/credentials). Add `http://127.0.0.1:5000` to its **Authorized JavaScript origins**.

The SQLite DB (`kanjisense.db`) is created automatically on first run.

## Deploy (Render)
1. Push this repo to GitHub.
2. On [Render](https://render.com): **New → Web Service**, connect the repo. The included `render.yaml` configures the build/start commands.
3. Add `GOOGLE_API_KEY` and `GOOGLE_CLIENT_ID` as environment variables in the Render dashboard.
4. Add your Render URL (e.g. `https://kanjisense.onrender.com`) to the OAuth client's **Authorized JavaScript origins**.

> **Note:** the free tier uses an ephemeral disk, so the SQLite database resets on each redeploy. For persistent data, attach a Render disk or switch to a managed Postgres database.

## Architecture
See [CLAUDE.md](CLAUDE.md) for a detailed walkthrough of the layers (`app.py` → `antigravity.run_agent` → `agent.py` tools → `db.py`).
