from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import date, datetime
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

Base = declarative_base()

# How many previously-reviewed cards "Review Due Today" serves per day.
DUE_LIMITS = {"low": 10, "medium": 20, "high": 40}
DEFAULT_DUE_LIMIT = "medium"

class User(Base):
    __tablename__ = "users"
    id         = Column(Integer, primary_key=True)
    google_sub = Column(String, unique=True, index=True)  # stable Google account id
    email      = Column(String)
    name       = Column(String)
    due_limit  = Column(String, default=DEFAULT_DUE_LIMIT)  # 'low' | 'medium' | 'high'
    created_at = Column(DateTime, default=datetime.utcnow)

class Session(Base):
    __tablename__ = "sessions"
    token      = Column(String, primary_key=True)   # opaque bearer token
    user_id    = Column(Integer, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class Flashcard(Base):
    __tablename__ = "flashcards"
    id               = Column(Integer, primary_key=True)
    user_id          = Column(Integer, index=True)  # owner; NULL = legacy/unclaimed
    kanji            = Column(String)
    reading          = Column(String)       # hiragana/katakana
    meaning          = Column(String)
    example_sentence = Column(String)
    image_url        = Column(String)
    chapter          = Column(String)
    ease_factor      = Column(Float, default=2.5)
    interval         = Column(Integer, default=1)
    repetitions      = Column(Integer, default=0)
    next_review      = Column(Date, default=date.today)

class ReviewLog(Base):
    __tablename__ = "review_logs"
    id       = Column(Integer, primary_key=True)
    user_id  = Column(Integer)
    card_id  = Column(Integer)
    correct  = Column(Boolean)
    quality  = Column(Integer)         # 0-5 SM-2 quality score
    reviewed_at = Column(Date, default=date.today)

class WateringLog(Base):
    """One row per day a user waters their garden (after clearing due cards).
    Cumulative row count drives tree growth; it is never deleted/decremented."""
    __tablename__ = "watering_logs"
    id         = Column(Integer, primary_key=True)
    user_id    = Column(Integer, index=True)
    watered_on = Column(Date, default=date.today)

engine = create_engine(f"sqlite:///{os.path.join(BASE_DIR, 'kanjisense.db')}")


def run_migrations():
    """Lightweight schema migration for pre-existing SQLite databases.

    create_all() only creates missing tables; it never alters existing ones.
    Older databases have a `flashcards` table without the `user_id` column,
    so add it in-place if absent (SQLite supports ADD COLUMN).
    """
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if "flashcards" in tables:
        columns = {c["name"] for c in inspector.get_columns("flashcards")}
        if "user_id" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE flashcards ADD COLUMN user_id INTEGER"))
    if "users" in tables:
        columns = {c["name"] for c in inspector.get_columns("users")}
        if "due_limit" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN due_limit VARCHAR DEFAULT 'medium'"))


Base.metadata.create_all(engine)
run_migrations()
SessionLocal = sessionmaker(bind=engine)
