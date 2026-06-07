document.addEventListener('DOMContentLoaded', () => {
    // Backend URL: same-origin everywhere (Flask :5000 in dev, the real domain in
    // production) — except VS Code Live Server on :5500, which must reach Flask on :5000.
    const BACKEND_URL = window.location.port === '5500' ? 'http://127.0.0.1:5000' : '';

    // ---- Auth (Google Sign-In + bearer token) ----
    const TOKEN_KEY = 'kanjisense_token';
    let authToken = localStorage.getItem(TOKEN_KEY);

    const appEl = document.getElementById('app');
    const loginOverlay = document.getElementById('login-overlay');
    const loginError = document.getElementById('login-error');
    const welcomeTitle = document.getElementById('welcome-title');

    // fetch wrapper that attaches the bearer token and handles expired sessions
    async function authedFetch(url, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const res = await fetch(url, { ...options, headers });
        if (res.status === 401) {
            handleLogout();
            throw new Error('Session expired. Please sign in again.');
        }
        return res;
    }

    function showApp(user) {
        loginOverlay.classList.add('hidden');
        appEl.classList.remove('hidden');
        if (welcomeTitle && user && user.name) {
            welcomeTitle.textContent = `Welcome back, ${user.name.split(' ')[0]}`;
        }
    }

    function showLogin(message) {
        appEl.classList.add('hidden');
        loginOverlay.classList.remove('hidden');
        if (message) {
            loginError.textContent = message;
            loginError.classList.remove('hidden');
        } else {
            loginError.classList.add('hidden');
        }
    }

    async function handleCredentialResponse(response) {
        try {
            const res = await fetch(`${BACKEND_URL}/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential: response.credential })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Sign-in failed');
            }
            const data = await res.json();
            authToken = data.token;
            localStorage.setItem(TOKEN_KEY, authToken);
            showApp(data.user);
            showDeckSelection();
        } catch (err) {
            console.error('Google sign-in failed:', err);
            showLogin(err.message || 'Sign-in failed. Please try again.');
        }
    }

    async function initGoogleSignIn() {
        try {
            const cfg = await (await fetch(`${BACKEND_URL}/auth/config`)).json();
            if (!cfg.client_id || cfg.client_id.startsWith('YOUR_')) {
                showLogin('Google login is not configured. Set GOOGLE_CLIENT_ID in the server .env file.');
                return;
            }
            const ready = () => window.google && window.google.accounts && window.google.accounts.id;
            const start = () => {
                google.accounts.id.initialize({
                    client_id: cfg.client_id,
                    callback: handleCredentialResponse
                });
                google.accounts.id.renderButton(
                    document.getElementById('google-signin-btn'),
                    { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with' }
                );
            };
            // The GIS script loads async; poll briefly until it's available.
            if (ready()) { start(); return; }
            let tries = 0;
            const timer = setInterval(() => {
                if (ready()) { clearInterval(timer); start(); }
                else if (++tries > 50) { clearInterval(timer); showLogin('Could not load Google Sign-In.'); }
            }, 100);
        } catch (err) {
            console.error('Auth config failed:', err);
            showLogin('Could not reach the server. Is it running on port 5000?');
        }
    }

    function handleLogout() {
        const tok = authToken;
        authToken = null;
        localStorage.removeItem(TOKEN_KEY);
        if (tok) {
            fetch(`${BACKEND_URL}/auth/logout`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tok}` }
            }).catch(() => {});
        }
        if (window.google && window.google.accounts && window.google.accounts.id) {
            google.accounts.id.disableAutoSelect();
        }
        showLogin();
        initGoogleSignIn();
    }

    async function initAuth() {
        if (authToken) {
            try {
                const res = await fetch(`${BACKEND_URL}/auth/me`, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    showApp(data.user);
                    showDeckSelection();
                    return;
                }
            } catch (err) {
                console.error('Session check failed:', err);
            }
            // Stored token is invalid/expired — drop it.
            authToken = null;
            localStorage.removeItem(TOKEN_KEY);
        }
        showLogin();
        initGoogleSignIn();
    }

    // State management
    let state = {
        currentView: 'review',
        selectedChapter: null,
        cards: [],
        currentIndex: 0,
        isFlipped: false
    };

    // DOM Elements
    const navReview = document.getElementById('nav-review');
    const navDue = document.getElementById('nav-due');
    const navStats = document.getElementById('nav-stats');
    const navWeak = document.getElementById('nav-weak');
    const navScan = document.getElementById('nav-scan');
    const navSettings = document.getElementById('nav-settings');
    const sectionReview = document.getElementById('section-review');
    const sectionScan = document.getElementById('section-scan');
    const sectionStats = document.getElementById('section-stats');
    const sectionSettings = document.getElementById('section-settings');
    const deckSelectionContainer = document.getElementById('deck-selection-container');
    const reviewSessionContainer = document.getElementById('review-session-container');
    const decksGrid = document.getElementById('decks-grid');
    const currentDeckTitle = document.getElementById('current-deck-title');
    const btnBackToDecks = document.getElementById('btn-back-to-decks');
    
    const flashcard = document.getElementById('flashcard');
    const controls = document.getElementById('controls');
    const dueCount = document.getElementById('due-count');
    const weakCountElement = document.getElementById('weak-count');
    
    const displayKanji = document.getElementById('display-kanji');
    const displayReading = document.getElementById('display-reading');
    const displayMeaning = document.getElementById('display-meaning');
    const displayExample = document.getElementById('display-example');

    // Navigation
    navReview.addEventListener('click', () => switchView('review'));
    navDue.addEventListener('click', () => switchView('due'));
    navStats.addEventListener('click', () => switchView('stats'));
    navWeak.addEventListener('click', () => switchView('weak'));
    navScan.addEventListener('click', () => switchView('scan'));
    navSettings.addEventListener('click', () => switchView('settings'));
    btnBackToDecks.addEventListener('click', () => switchView('review'));
    document.getElementById('nav-logout').addEventListener('click', handleLogout);
    document.getElementById('water-can-btn').addEventListener('click', waterGarden);

    const navItems = [navReview, navDue, navStats, navWeak, navScan, navSettings];
    function setActiveNav(el) {
        navItems.forEach(n => n && n.classList.remove('active'));
        if (el) el.classList.add('active');
    }

    function switchView(view) {
        state.currentView = view;
        // Hide all top-level sections, then reveal the one we want.
        sectionReview.classList.add('hidden');
        sectionScan.classList.add('hidden');
        sectionStats.classList.add('hidden');
        sectionSettings.classList.add('hidden');

        if (view === 'scan') {
            setActiveNav(navScan);
            sectionScan.classList.remove('hidden');
        } else if (view === 'settings') {
            setActiveNav(navSettings);
            sectionSettings.classList.remove('hidden');
            loadSettings();
        } else if (view === 'stats') {
            setActiveNav(navStats);
            sectionStats.classList.remove('hidden');
            loadGarden();
        } else if (view === 'due') {
            // Review section, but jump straight into a due-cards session.
            setActiveNav(navDue);
            sectionReview.classList.remove('hidden');
            startSpecialSession('/review/due', 'Due Today');
        } else if (view === 'weak') {
            setActiveNav(navWeak);
            sectionReview.classList.remove('hidden');
            startSpecialSession('/review/weak', 'Weak Cards');
        } else {
            // 'review' — chapter dashboard
            setActiveNav(navReview);
            sectionReview.classList.remove('hidden');
            showDeckSelection();
        }
    }

    // Swipe / Drag State variables
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let currentY = 0;
    let isDragging = false;
    const dragThreshold = 120; // px required to confirm swipe
    const clickThreshold = 8;  // px max to differentiate click vs drag

    // Elements
    const forgotIndicator = document.querySelector('.forgot-indicator');
    const rememberIndicator = document.querySelector('.remember-indicator');
    const btnForgot = document.getElementById('btn-forgot');
    const btnRemember = document.getElementById('btn-remember');

    // Button event listeners
    btnForgot.addEventListener('click', (e) => {
        e.stopPropagation();
        swipeCard('left');
    });

    btnRemember.addEventListener('click', (e) => {
        e.stopPropagation();
        swipeCard('right');
    });

    // Flip Card logic
    function flipCard() {
        if (!state.cards[state.currentIndex]) return;
        state.isFlipped = !state.isFlipped;
        flashcard.classList.toggle('flipped', state.isFlipped);
        if (state.isFlipped) {
            controls.classList.remove('hidden');
        } else {
            controls.classList.add('hidden');
        }
    }

    // Keyboard support
    document.addEventListener('keydown', (e) => {
        if (state.currentView !== 'review') return;
        if (!state.cards[state.currentIndex]) return;

        if (e.code === 'Space' || e.code === 'Enter') {
            e.preventDefault();
            flipCard();
        } else if (e.code === 'ArrowLeft') {
            if (state.isFlipped) {
                e.preventDefault();
                swipeCard('left');
            }
        } else if (e.code === 'ArrowRight') {
            if (state.isFlipped) {
                e.preventDefault();
                swipeCard('right');
            }
        }
    });

    // Mouse / Touch drag handlers
    flashcard.addEventListener('mousedown', startDrag);
    flashcard.addEventListener('touchstart', startDrag, { passive: true });

    function startDrag(e) {
        if (!state.cards[state.currentIndex]) return;

        isDragging = true;
        if (state.isFlipped) {
            flashcard.classList.add('dragging');
            flashcard.classList.remove('snapping-back');
        }

        const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

        startX = clientX;
        startY = clientY;
        currentX = clientX;
        currentY = clientY;

        if (e.type === 'mousedown') {
            document.addEventListener('mousemove', dragMove);
            document.addEventListener('mouseup', endDrag);
        } else {
            document.addEventListener('touchmove', dragMove, { passive: true });
            document.addEventListener('touchend', endDrag);
        }
    }

    function dragMove(e) {
        if (!isDragging) return;

        const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

        currentX = clientX;
        currentY = clientY;

        if (!state.isFlipped) return;

        const deltaX = currentX - startX;
        const deltaY = currentY - startY;

        const rotation = deltaX * 0.08;
        flashcard.style.transform = `translate(${deltaX}px, ${deltaY}px) rotate(${rotation}deg)`;

        const ratio = Math.min(Math.abs(deltaX) / dragThreshold, 1);
        if (deltaX < 0) {
            forgotIndicator.style.opacity = ratio;
            rememberIndicator.style.opacity = 0;
        } else {
            rememberIndicator.style.opacity = ratio;
            forgotIndicator.style.opacity = 0;
        }
    }

    function endDrag(e) {
        if (!isDragging) return;
        isDragging = false;

        document.removeEventListener('mousemove', dragMove);
        document.removeEventListener('mouseup', endDrag);
        document.removeEventListener('touchmove', dragMove);
        document.removeEventListener('touchend', endDrag);

        flashcard.classList.remove('dragging');

        const deltaX = currentX - startX;
        const deltaY = currentY - startY;
        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);

        if (absDeltaX < clickThreshold && absDeltaY < clickThreshold) {
            flashcard.style.transform = '';
            flipCard();
            forgotIndicator.style.opacity = 0;
            rememberIndicator.style.opacity = 0;
            return;
        }

        if (!state.isFlipped) {
            forgotIndicator.style.opacity = 0;
            rememberIndicator.style.opacity = 0;
            return;
        }

        if (deltaX < -dragThreshold) {
            swipeCard('left', deltaY);
        } else if (deltaX > dragThreshold) {
            swipeCard('right', deltaY);
        } else {
            snapBack();
        }
    }

    function snapBack() {
        flashcard.classList.add('snapping-back');
        flashcard.style.transform = '';
        forgotIndicator.style.opacity = 0;
        rememberIndicator.style.opacity = 0;
        setTimeout(() => {
            flashcard.classList.remove('snapping-back');
        }, 400);
    }

    function swipeCard(direction, finalY = 0) {
        flashcard.classList.remove('dragging', 'snapping-back');
        const quality = direction === 'left' ? 1 : 5;
        
        if (direction === 'left') {
            flashcard.classList.add('swiping-left');
            forgotIndicator.style.opacity = 1;
            rememberIndicator.style.opacity = 0;
            flashcard.style.transform = `translate(-600px, ${finalY}px) rotate(-30deg)`;
        } else {
            flashcard.classList.add('swiping-right');
            rememberIndicator.style.opacity = 1;
            forgotIndicator.style.opacity = 0;
            flashcard.style.transform = `translate(600px, ${finalY}px) rotate(30deg)`;
        }
        
        setTimeout(() => {
            // Apply hidden state and no transition to reset instantly off-screen
            flashcard.classList.add('hidden-state', 'no-transition');
            
            submitReview(quality);
            resetCardState();
            
            // Now fade the card back in with the new card content
            setTimeout(() => {
                flashcard.classList.remove('hidden-state', 'no-transition');
                flashcard.classList.add('fade-in-effect');
                
                // Cleanup fade-in class after animation completes (300ms)
                setTimeout(() => {
                    flashcard.classList.remove('fade-in-effect');
                }, 300);
            }, 50);
        }, 350); // wait until swiped off-screen
    }

    function resetCardState() {
        forgotIndicator.style.opacity = 0;
        rememberIndicator.style.opacity = 0;
        flashcard.classList.remove('swiping-left', 'swiping-right', 'flipped');
        flashcard.style.transform = '';
        state.isFlipped = false;
        controls.classList.add('hidden');
    }

    // API Calls
    async function showDeckSelection() {
        state.selectedChapter = null;
        deckSelectionContainer.classList.remove('hidden');
        reviewSessionContainer.classList.add('hidden');
        
        try {
            const response = await authedFetch(`${BACKEND_URL}/chapters`);
            const data = await response.json();
            renderDecks(data.chapters || []);
        } catch (err) {
            console.error('Failed to fetch chapters:', err);
            decksGrid.innerHTML = '<div class="error-msg">Failed to load decks. Check connection.</div>';
        }
    }

    function renderDecks(chapters) {
        decksGrid.innerHTML = '';
        if (chapters.length === 0) {
            decksGrid.innerHTML = `
                <div class="empty-state">
                    <p>No chapter cards found.</p>
                    <button id="btn-go-scan" class="primary-btn" style="margin-top: 15px;">Scan Textbook Page</button>
                </div>
            `;
            document.getElementById('btn-go-scan')?.addEventListener('click', () => switchView('scan'));
            return;
        }

        chapters.forEach(deck => {
            const card = document.createElement('div');
            card.className = 'deck-card';
            
            // Calculate progress percentage and determine border & text color
            let percentageBoxHtml = '';
            if (deck.card_count > 0) {
                const scorePercent = Math.round((deck.remembered_count / deck.card_count) * 100);
                let scoreColor = '#ef4444'; // Under 50% is red
                if (scorePercent >= 80) {
                    scoreColor = '#10b981'; // 80% and above is green
                } else if (scorePercent >= 50) {
                    scoreColor = '#eab308'; // 50% to 79% is yellow/amber
                }
                percentageBoxHtml = `<span class="deck-card-percentage" style="border-color: ${scoreColor}; color: ${scoreColor};">${scorePercent}%</span>`;
            } else {
                percentageBoxHtml = `<span class="deck-card-percentage" style="border-color: #64748b; color: #64748b;">0%</span>`;
            }

            card.innerHTML = `
                <div class="deck-card-actions">
                    <button class="deck-action-btn deck-rename-btn" title="Rename chapter" aria-label="Rename ${deck.name}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="deck-action-btn deck-delete-btn" title="Delete chapter" aria-label="Delete ${deck.name}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                    </button>
                </div>
                <div class="deck-card-header">
                    <h3 class="deck-card-title">${deck.name}</h3>
                    <p class="deck-card-count">
                        <span>${deck.card_count} vocabulary cards</span>
                        ${percentageBoxHtml}
                    </p>
                </div>
                <div class="deck-card-footer">
                    <button class="deck-card-action">Review</button>
                </div>
            `;

            // Rename button handler
            card.querySelector('.deck-rename-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                const newName = prompt(`Enter new name for chapter "${deck.name}":`, deck.name);
                if (newName === null) return;
                const trimmed = newName.trim();
                if (!trimmed) {
                    alert('Chapter name cannot be empty.');
                    return;
                }
                if (trimmed === deck.name) return;
                
                try {
                    const res = await authedFetch(`${BACKEND_URL}/chapter/${encodeURIComponent(deck.name)}/rename`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ new_name: trimmed })
                    });
                    if (!res.ok) throw new Error('Failed to rename');
                    showDeckSelection();
                } catch (err) {
                    console.error('Rename failed:', err);
                    alert('Failed to rename chapter. Please try again.');
                }
            });

            // Delete button handler
            card.querySelector('.deck-delete-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete "${deck.name}" and all its ${deck.card_count} cards? This cannot be undone.`)) return;
                try {
                    const res = await authedFetch(`${BACKEND_URL}/chapter/${encodeURIComponent(deck.name)}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error('Failed to delete');
                    showDeckSelection(); // refresh
                } catch (err) {
                    console.error('Delete failed:', err);
                    alert('Failed to delete chapter. Please try again.');
                }
            });

            card.addEventListener('click', () => startReviewSession(deck.name));
            decksGrid.appendChild(card);
        });
    }

    function startReviewSession(chapterName) {
        state.selectedChapter = chapterName;
        currentDeckTitle.textContent = chapterName;
        deckSelectionContainer.classList.add('hidden');
        reviewSessionContainer.classList.remove('hidden');
        fetchReviewSession(chapterName);
    }

    async function fetchReviewSession(chapterName) {
        try {
            const response = await authedFetch(`${BACKEND_URL}/review/session?chapter=${encodeURIComponent(chapterName)}`);
            const data = await response.json();
            let cards = data.cards || [];
            
            // Unbiased Fisher-Yates Shuffle
            for (let i = cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cards[i], cards[j]] = [cards[j], cards[i]];
            }
            
            state.cards = cards;
            state.currentIndex = 0;
            updateStats(data.weak_count || 0);
            showNextCard();
        } catch (err) {
            console.error('Failed to fetch session:', err);
        }
    }

    function updateStats(weakCount) {
        dueCount.textContent = state.cards.length;
        weakCountElement.textContent = weakCount;
    }

    // Due Today / Weak Cards sessions reuse the flashcard reviewer but skip
    // chapter selection and pull cards from a dedicated endpoint instead.
    async function startSpecialSession(endpoint, title) {
        state.selectedChapter = null;
        currentDeckTitle.textContent = title;
        deckSelectionContainer.classList.add('hidden');
        reviewSessionContainer.classList.remove('hidden');
        try {
            const response = await authedFetch(`${BACKEND_URL}${endpoint}`);
            const data = await response.json();
            let cards = data.cards || [];

            // Unbiased Fisher-Yates Shuffle
            for (let i = cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cards[i], cards[j]] = [cards[j], cards[i]];
            }

            state.cards = cards;
            state.currentIndex = 0;
            updateStats(data.weak_count || 0);
            showNextCard();
        } catch (err) {
            console.error('Failed to start session:', err);
        }
    }

    // Tree stages, indexed by the backend's stage_index (0..4). Thresholds must
    // mirror GARDEN_STAGES in app.py so the progress bar lines up.
    const GARDEN_STAGES = [
        { emoji: '🌰', label: 'Seed', size: '64px' },
        { emoji: '🌱', label: 'Sprout', size: '78px' },
        { emoji: '🌿', label: 'Sapling', size: '94px' },
        { emoji: '🪴', label: 'Young Tree', size: '108px' },
        { emoji: '🌳', label: 'Mighty Tree', size: '124px' },
    ];
    const STAGE_THRESHOLDS = [0, 1, 5, 15, 30];

    function renderGarden(g) {
        const idx = Math.max(0, Math.min(g.stage_index || 0, GARDEN_STAGES.length - 1));
        const stage = GARDEN_STAGES[idx];

        const scene = document.getElementById('garden-scene');
        if (scene) scene.classList.toggle('wilting', !!g.wilting);

        const plant = document.getElementById('plant-emoji');
        if (plant) { plant.textContent = stage.emoji; plant.style.fontSize = stage.size; }

        const stageName = document.getElementById('garden-stage-name');
        if (stageName) stageName.textContent = stage.label + (g.wilting ? ' · thirsty 🥀' : '');

        const sun = document.getElementById('sun-streak');
        if (sun) sun.textContent = g.streak_days || 0;

        // Flowers represent mastery
        const layer = document.getElementById('flower-layer');
        if (layer) layer.textContent = '🌸'.repeat(g.flowers || 0);

        // Growth bar: progress within the current stage band toward the next
        const fill = document.getElementById('growth-fill');
        const caption = document.getElementById('growth-caption');
        if (g.next_stage_at == null) {
            if (fill) fill.style.width = '100%';
            if (caption) caption.textContent = `Fully grown · ${g.watering_days} watering days`;
        } else {
            const base = STAGE_THRESHOLDS[idx];
            const span = g.next_stage_at - base;
            const into = g.watering_days - base;
            const pct = span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 0;
            if (fill) fill.style.width = pct + '%';
            const remaining = g.next_stage_at - g.watering_days;
            if (caption) caption.textContent = `${remaining} more watering day${remaining === 1 ? '' : 's'} to grow`;
        }

        // Watering can state
        const can = document.getElementById('water-can-btn');
        const cap = document.getElementById('water-caption');
        if (can && cap) {
            can.classList.remove('can-ready', 'can-locked', 'can-done');
            if (g.water_available) {
                can.disabled = false;
                can.classList.add('can-ready');
                cap.textContent = 'Tap to water! 💧';
            } else if (g.watered_today) {
                can.disabled = true;
                can.classList.add('can-done');
                cap.textContent = 'Watered today 🌱';
            } else {
                can.disabled = true;
                can.classList.add('can-locked');
                const due = g.due_today || 0;
                cap.textContent = due > 0
                    ? `${due} card${due === 1 ? '' : 's'} left to water`
                    : 'Review to earn water';
            }
        }
    }

    async function loadGarden() {
        try {
            const res = await authedFetch(`${BACKEND_URL}/garden`);
            renderGarden(await res.json());
        } catch (err) {
            console.error('Failed to load garden:', err);
        }
    }

    let isWatering = false;
    async function waterGarden() {
        if (isWatering) return;
        isWatering = true;
        const can = document.getElementById('water-can-btn');
        if (can) can.disabled = true;
        try {
            const res = await authedFetch(`${BACKEND_URL}/garden/water`, { method: 'POST' });
            const data = await res.json();
            renderGarden(data);
            if (data.watered && data.grew) {
                const plant = document.getElementById('plant-emoji');
                if (plant) {
                    plant.classList.remove('grow-pop');
                    void plant.offsetWidth; // restart the animation
                    plant.classList.add('grow-pop');
                }
            }
        } catch (err) {
            console.error('Failed to water garden:', err);
            loadGarden();
        } finally {
            isWatering = false;
        }
    }

    // ---- Settings ----
    const dueLimitGroup = document.getElementById('due-limit-group');
    const dueSegments = dueLimitGroup ? Array.from(dueLimitGroup.querySelectorAll('.segment')) : [];
    let selectedDueLimit = 'medium';

    function setDueLimitSelection(value) {
        selectedDueLimit = value;
        dueSegments.forEach(s => s.classList.toggle('active', s.dataset.value === value));
    }
    dueSegments.forEach(s => s.addEventListener('click', () => setDueLimitSelection(s.dataset.value)));

    async function loadSettings() {
        const status = document.getElementById('settings-status');
        if (status) { status.textContent = ''; status.className = 'settings-status'; }
        try {
            const res = await authedFetch(`${BACKEND_URL}/auth/me`);
            const u = (await res.json()).user || {};
            const nameInput = document.getElementById('settings-username');
            if (nameInput) nameInput.value = u.name || '';
            setDueLimitSelection(u.due_limit || 'medium');
        } catch (err) {
            console.error('Failed to load settings:', err);
        }
    }

    const settingsSaveBtn = document.getElementById('settings-save');
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', async () => {
            const status = document.getElementById('settings-status');
            const nameInput = document.getElementById('settings-username');
            const name = (nameInput ? nameInput.value : '').trim();
            settingsSaveBtn.disabled = true;
            try {
                const res = await authedFetch(`${BACKEND_URL}/settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, due_limit: selectedDueLimit })
                });
                const data = await res.json();
                // Reflect a new name on the dashboard banner right away
                if (welcomeTitle && data.name) welcomeTitle.textContent = `Welcome back, ${data.name.split(' ')[0]}`;
                if (status) { status.textContent = 'Saved \u2713'; status.className = 'settings-status ok'; }
            } catch (err) {
                console.error('Failed to save settings:', err);
                if (status) { status.textContent = 'Save failed'; status.className = 'settings-status err'; }
            } finally {
                settingsSaveBtn.disabled = false;
            }
        });
    }

    function containsKanji(text) {
        if (!text) return false;
        return /[\u4e00-\u9faf]/.test(text);
    }

    function showNextCard() {
        if (state.currentIndex >= state.cards.length) {
            displayKanji.textContent = '🎉';
            displayKanji.style.setProperty('--char-count', 1);
            displayReading.textContent = '';
            displayMeaning.textContent = 'Session Complete!';
            displayExample.textContent = '';
            controls.classList.add('hidden');
            return;
        }

        const card = state.cards[state.currentIndex];
        
        if (containsKanji(card.kanji)) {
            // Kanji Card: front has kanji, back has reading + meaning
            displayKanji.textContent = card.kanji;
            displayKanji.style.setProperty('--char-count', card.kanji ? card.kanji.length : 1);
            displayReading.textContent = card.reading;
        } else {
            // Kana Card: front has kana, back has meaning only (reading is hidden/redundant)
            const kanaText = card.kanji || card.reading;
            displayKanji.textContent = kanaText;
            displayKanji.style.setProperty('--char-count', kanaText ? kanaText.length : 1);
            displayReading.textContent = ''; 
        }

        displayMeaning.textContent = card.meaning;
        displayExample.textContent = card.example_sentence || '';
        


        // Reset flip state
        state.isFlipped = false;
        flashcard.classList.remove('flipped');
        controls.classList.add('hidden');
    }

    async function submitReview(quality) {
        const card = state.cards[state.currentIndex];
        // Advance local state optimistically to prevent lag/flashing
        state.currentIndex++;
        showNextCard();
        
        try {
            await authedFetch(`${BACKEND_URL}/review/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card_id: card.id, quality })
            });
        } catch (err) {
            console.error('Failed to submit review:', err);
        }
    }

    // Scan Logic
    const btnScan = document.getElementById('btn-scan-process');
    const scanStatus = document.getElementById('scan-status');
    const chapterInput = document.getElementById('chapter-name');
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const dropZoneContent = document.getElementById('drop-zone-content');
    const imagePreview = document.getElementById('image-preview');

    // Make the entire drop zone clickable
    dropZone.addEventListener('click', (e) => {
        // Prevent click events originating on fileInput itself from infinitely bubbling
        if (e.target !== fileInput) {
            fileInput.click();
        }
    });

    // Drag and Drop handlers
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--accent)';
        dropZone.style.backgroundColor = 'rgba(56, 189, 248, 0.1)';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '#334155';
        dropZone.style.backgroundColor = 'transparent';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#334155';
        dropZone.style.backgroundColor = 'transparent';
        
        if (e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect();
        }
    });

    fileInput.addEventListener('change', handleFileSelect);

    function handleFileSelect() {
        const file = fileInput.files[0];
        if (file) {
            scanStatus.textContent = `Selected: ${file.name}`;
            scanStatus.style.color = 'var(--accent)';
            
            // Generate a premium image preview
            const reader = new FileReader();
            reader.onload = (e) => {
                imagePreview.src = e.target.result;
                imagePreview.classList.remove('hidden');
                dropZoneContent.classList.add('hidden');
            };
            reader.readAsDataURL(file);
        } else {
            imagePreview.src = '';
            imagePreview.classList.add('hidden');
            dropZoneContent.classList.remove('hidden');
        }
    }

    let isScanInProgress = false;

    btnScan.addEventListener('click', async () => {
        if (isScanInProgress) return;
        
        const file = fileInput.files[0];
        const chapter = chapterInput.value;

        if (!file) {
            alert('Please select or drop an image first.');
            return;
        }
        if (!chapter) {
            alert('Please enter a Chapter Name (e.g., "Chapter 1").');
            return;
        }

        // Lock to prevent duplicate requests
        isScanInProgress = true;

        // UI Loading State
        const originalBtnText = btnScan.innerHTML;
        btnScan.disabled = true;
        btnScan.innerHTML = '<span class="spinner"></span>Processing...';
        scanStatus.textContent = '🚀 Sending image to Gemini AI...';
        scanStatus.style.color = 'var(--accent)';
        
        console.log('Starting OCR process for chapter:', chapter);
        
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = reader.result.split(',')[1];
                console.log('File read successful, sending POST request...');
                
                const response = await authedFetch(`${BACKEND_URL}/scan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_base64: base64, chapter })
                });
                
                console.log('Response received:', response.status);
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Server error');
                }
                
                const result = await response.json();
                console.log('Scan result:', result);
                
                scanStatus.textContent = '✅ Scan complete! New cards created.';
                scanStatus.style.color = 'var(--success)';
                
                // Clear inputs and preview
                fileInput.value = '';
                chapterInput.value = '';
                imagePreview.src = '';
                imagePreview.classList.add('hidden');
                dropZoneContent.classList.remove('hidden');
                
                setTimeout(() => switchView('review'), 2000);
            } catch (err) {
                console.error('Scan Error:', err);
                scanStatus.textContent = `❌ Error: ${err.message || 'Check your API key or connection.'}`;
                scanStatus.style.color = 'var(--danger)';
            } finally {
                btnScan.disabled = false;
                btnScan.innerHTML = originalBtnText;
                isScanInProgress = false;
            }
        };
        reader.onerror = () => {
            scanStatus.textContent = '❌ Failed to read the file.';
            scanStatus.style.color = 'var(--danger)';
            btnScan.disabled = false;
            btnScan.innerHTML = originalBtnText;
            isScanInProgress = false;
        };
        reader.readAsDataURL(file);
    });

    // Theme Toggle Logic
    const themeCheckbox = document.getElementById('theme-toggle-checkbox');
    const themeText = document.getElementById('theme-text');
    const sunIcon = document.querySelector('.theme-toggle-item .sun-icon');
    const moonIcon = document.querySelector('.theme-toggle-item .moon-icon');

    if (themeCheckbox && themeText && sunIcon && moonIcon) {
        themeCheckbox.addEventListener('change', () => {
            if (themeCheckbox.checked) {
                // Dark Mode active
                document.body.classList.remove('light-theme');
                themeText.textContent = 'Dark Mode';
                sunIcon.classList.add('hidden');
                moonIcon.classList.remove('hidden');
                localStorage.setItem('theme', 'dark');
            } else {
                // Light Mode active
                document.body.classList.add('light-theme');
                themeText.textContent = 'Light Mode';
                sunIcon.classList.remove('hidden');
                moonIcon.classList.add('hidden');
                localStorage.setItem('theme', 'light');
            }
        });

        // Load saved theme preference
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            themeCheckbox.checked = false;
            document.body.classList.add('light-theme');
            themeText.textContent = 'Light Mode';
            sunIcon.classList.remove('hidden');
            moonIcon.classList.add('hidden');
        } else {
            themeCheckbox.checked = true;
            document.body.classList.remove('light-theme');
            themeText.textContent = 'Dark Mode';
            sunIcon.classList.add('hidden');
            moonIcon.classList.remove('hidden');
        }
    }

    // Initial Load — gate the app behind Google sign-in.
    initAuth();
});
