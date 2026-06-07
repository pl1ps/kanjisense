import json
import os
import google.generativeai as genai

class Agent:
    def __init__(self, name, model, system, tools):
        self.name = name
        self.model = model
        self.system = system
        self.tools = {t.__name__: t for t in tools}

def tool(description):
    def decorator(func):
        func.__antigravity_tool_description__ = description
        return func
    return decorator

def run_agent(agent, task, context=None):
    """
    A lightweight implementation of the Antigravity Agent Loop.
    Perceive (Task) -> Reason (Gemini) -> Act (Tools)
    """
    model = genai.GenerativeModel(agent.model)
    
    tool_info = []
    for name, f in agent.tools.items():
        desc = getattr(f, '__antigravity_tool_description__', 'No description')
        tool_info.append(f"{name}: {desc}")
    
    tools_str = "\n".join(tool_info)
    
    # We ask Gemini to decide which tools to call to achieve the task.
    # For this implementation, we guide it to return tool calls in a structured way.
    prompt = f"""
    {agent.system}
    
    You have access to these tools:
    {tools_str}
    
    Task: {task}
    Context: {context if context else 'None'}
    
    Instructions:
    1. Decide which tools to call to complete the task.
    2. You can call multiple tools in sequence.
    3. Return your final answer or a list of tool calls to execute.
    4. If you need to call a tool, use this format: [CALL: tool_name(arg1=val1, ...)]
    5. Be concise.
    """
    
    # For a simple demo, we'll let Gemini handle the specific logic 
    # and we will manually map the most common tasks to the tools 
    # to ensure the UI works perfectly right now.
    
    # Every data-touching branch is scoped to the logged-in user, supplied by
    # app.py via context['user_id'].
    user_id = context.get('user_id') if context else None

    if "Scan this image" in task:
        # OCR -> Create
        image_b64 = context.get('image_base64')
        chapter = context.get('chapter')

        # 1. OCR
        words = agent.tools['ocr_scan_image'](image_b64)

        results = []
        for word in words:
            # 2. Create (owned by the current user)
            card = agent.tools['create_flashcard'](
                kanji=word['kanji'],
                reading=word['reading'],
                meaning=word['meaning'],
                example_sentence=word.get('example_sentence', ''),
                image_url="",
                chapter=chapter,
                user_id=user_id
            )
            results.append(card)
        return {"status": "success", "cards_created": len(results), "cards": results}

    elif "Build a review session" in task:
        chapter = context.get('chapter') if context else None
        if not chapter:
            import re
            match = re.search(r"chapter '([^']+)'", task)
            if match:
                chapter = match.group(1)

        if chapter:
            cards = agent.tools['get_chapter_cards'](chapter, user_id)
        else:
            cards = []

        if not cards:
             # Try to get any of this user's cards if selected chapter is empty or not found
             from db import SessionLocal, Flashcard
             db = SessionLocal()
             any_cards = db.query(Flashcard).filter_by(user_id=user_id).limit(20).all()
             cards = [{"id": c.id, "kanji": c.kanji, "reading": c.reading, "meaning": c.meaning, "image_url": c.image_url} for c in any_cards]
             db.close()

        import random
        random.shuffle(cards)

        return {"cards": cards, "weak_count": 0}

    elif "Build a due review session" in task:
        cards = agent.tools['get_due_cards'](user_id)
        import random
        random.shuffle(cards)
        return {"cards": cards, "weak_count": 0}

    elif "Build a weak review session" in task:
        cards = agent.tools['get_weak_cards'](user_id)
        return {"cards": cards, "weak_count": len(cards)}

    elif "Record review result" in task:
        # Extract card_id and quality from task string using simple parsing
        import re
        card_id = int(re.search(r'card (\d+)', task).group(1))
        quality = int(re.search(r'quality score (\d+)', task).group(1))

        # Schedule (only succeeds if the card belongs to this user)
        result = agent.tools['schedule_review'](card_id, quality, user_id)
        return result

    elif "Get all flashcards" in task:
        import re
        match = re.search(r"chapter '([^']+)'", task)
        chapter = match.group(1) if match else "Genki Chapter 1"
        cards = agent.tools['get_chapter_cards'](chapter, user_id)
        return {"cards": cards}

    # Fallback to simple generation
    response = model.generate_content(prompt)
    return {"output": response.text}
