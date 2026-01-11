-- ============================================
-- VidVault Database Schema
-- Cloudflare D1 (SQLite)
-- ============================================

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    email_verified INTEGER DEFAULT 0,
    password_hash TEXT,
    name TEXT,
    auth_provider TEXT DEFAULT 'email',
    google_id TEXT UNIQUE,
    is_admin INTEGER DEFAULT 0,
    daily_upload_count INTEGER DEFAULT 0,
    daily_upload_reset_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT DEFAULT (datetime('now')),
    visibility_unlocked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- ============================================
-- CATEGORIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================
-- SUBCATEGORIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS subcategories (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(category_id, name)
);

CREATE INDEX IF NOT EXISTS idx_subcategories_category ON subcategories(category_id);

-- ============================================
-- VIDEOS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    youtube_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    channel_name TEXT,
    channel_id TEXT,
    duration_seconds INTEGER,
    duration_formatted TEXT,
    thumbnail_url TEXT,
    category_id TEXT NOT NULL REFERENCES categories(id),
    subcategory_id TEXT REFERENCES subcategories(id),
    added_by_user_id TEXT NOT NULL REFERENCES users(id),
    avg_rating REAL DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    rating_sum REAL DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    is_flagged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_rated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id);
CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category_id);
CREATE INDEX IF NOT EXISTS idx_videos_subcategory ON videos(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_avg_rating ON videos(avg_rating DESC);
CREATE INDEX IF NOT EXISTS idx_videos_discovery ON videos(is_visible, created_at DESC, avg_rating DESC);

-- ============================================
-- VIDEO TAGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS video_tags (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag);

-- ============================================
-- RATINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating >= 0 AND rating <= 10),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(video_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_video ON ratings(video_id);
CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);

-- ============================================
-- USER SEEN VIDEOS
-- ============================================
CREATE TABLE IF NOT EXISTS user_seen_videos (
    user_id TEXT NOT NULL REFERENCES users(id),
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    seen_at TEXT DEFAULT (datetime('now')),
    interaction_type TEXT DEFAULT 'view',
    PRIMARY KEY (user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_seen_videos_user ON user_seen_videos(user_id, seen_at DESC);

-- ============================================
-- ALGORITHM PARAMETERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS algorithm_params (
    id TEXT PRIMARY KEY DEFAULT 'default',
    freshness_weight REAL DEFAULT 0.25,
    quality_weight REAL DEFAULT 0.40,
    popularity_weight REAL DEFAULT 0.15,
    randomness_factor REAL DEFAULT 0.20,
    seen_suppression_strength REAL DEFAULT 0.70,
    seen_decay_days INTEGER DEFAULT 30,
    new_account_visibility_days INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================
-- SPAM CONFIGURATION TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS spam_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    daily_upload_limit INTEGER DEFAULT 5,
    duplicate_window_hours INTEGER DEFAULT 24,
    min_account_age_hours INTEGER DEFAULT 24,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================
-- EMAIL VERIFICATION TOKENS
-- ============================================
CREATE TABLE IF NOT EXISTS email_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

-- ============================================
-- AUDIT LOG
-- ============================================
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    user_id TEXT REFERENCES users(id),
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- ============================================
-- SEED DATA
-- ============================================

-- Default algorithm parameters
INSERT OR IGNORE INTO algorithm_params (id) VALUES ('default');

-- Default spam configuration
INSERT OR IGNORE INTO spam_config (id) VALUES ('default');

-- Seed Categories
INSERT OR IGNORE INTO categories (id, name, icon, sort_order) VALUES
    ('education', 'Education', '📚', 1),
    ('arts', 'Arts & Culture', '🎨', 2),
    ('nature', 'Nature & Wildlife', '🌿', 3),
    ('tech', 'Technology', '⚡', 4),
    ('lifestyle', 'Lifestyle', '✨', 5),
    ('stories', 'Stories & Docs', '📖', 6);

-- Seed Subcategories
INSERT OR IGNORE INTO subcategories (id, category_id, name, sort_order) VALUES
    ('edu-science', 'education', 'Science', 1),
    ('edu-history', 'education', 'History', 2),
    ('edu-math', 'education', 'Mathematics', 3),
    ('edu-language', 'education', 'Language', 4),
    ('edu-philosophy', 'education', 'Philosophy', 5),
    ('edu-technology', 'education', 'Technology', 6),

    ('arts-music', 'arts', 'Music', 1),
    ('arts-film', 'arts', 'Film', 2),
    ('arts-visual', 'arts', 'Visual Arts', 3),
    ('arts-photo', 'arts', 'Photography', 4),
    ('arts-arch', 'arts', 'Architecture', 5),
    ('arts-design', 'arts', 'Design', 6),

    ('nature-wildlife', 'nature', 'Wildlife', 1),
    ('nature-oceans', 'nature', 'Oceans', 2),
    ('nature-space', 'nature', 'Space', 3),
    ('nature-weather', 'nature', 'Weather', 4),
    ('nature-geo', 'nature', 'Geography', 5),
    ('nature-env', 'nature', 'Environment', 6),

    ('tech-programming', 'tech', 'Programming', 1),
    ('tech-ai', 'tech', 'AI & ML', 2),
    ('tech-hardware', 'tech', 'Hardware', 3),
    ('tech-startups', 'tech', 'Startups', 4),
    ('tech-security', 'tech', 'Cybersecurity', 5),
    ('tech-gadgets', 'tech', 'Gadgets', 6),

    ('life-travel', 'lifestyle', 'Travel', 1),
    ('life-food', 'lifestyle', 'Food', 2),
    ('life-fitness', 'lifestyle', 'Fitness', 3),
    ('life-mindful', 'lifestyle', 'Mindfulness', 4),
    ('life-diy', 'lifestyle', 'DIY', 5),
    ('life-fashion', 'lifestyle', 'Fashion', 6),

    ('stories-docs', 'stories', 'Documentaries', 1),
    ('stories-interviews', 'stories', 'Interviews', 2),
    ('stories-crime', 'stories', 'True Crime', 3),
    ('stories-bio', 'stories', 'Biographies', 4),
    ('stories-journalism', 'stories', 'Journalism', 5),
    ('stories-essays', 'stories', 'Essays', 6);

-- Create admin user (password: admin123)
INSERT OR IGNORE INTO users (id, email, password_hash, name, is_admin, email_verified, visibility_unlocked_at, daily_upload_reset_at)
VALUES (
    'admin-user-001',
    'admin@vidvault.app',
    'jGl25bVBBBW96Qi9Te4V37Fnqchz/Eu4qB9vKrRIqRg=',  -- SHA-256 of 'admin123'
    'Admin',
    1,
    1,
    datetime('now'),
    datetime('now', '+1 day')
);
