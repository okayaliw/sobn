# VidVault - Curated Video Discovery Platform

## 🎯 Overview

VidVault is a thoughtfully designed YouTube video discovery platform that prioritizes quality curation over engagement metrics. Unlike traditional social media, it creates a calm, loop-free exploration experience while maintaining algorithmic intelligence.

---

## 🏗️ System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge Network                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │   Cloudflare │    │  Cloudflare  │    │    Cloudflare D1     │  │
│  │    Pages     │◄──►│   Workers    │◄──►│  (SQLite Database)   │  │
│  │   (Static)   │    │    (API)     │    │                      │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│         │                   │                       │               │
│         │                   │                       │               │
│         ▼                   ▼                       ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  Cloudflare  │    │  Cloudflare  │    │    YouTube oEmbed    │  │
│  │     KV       │    │   R2 Bucket  │    │        API           │  │
│  │  (Sessions)  │    │  (Assets)    │    │   (Video Metadata)   │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Purpose |
|-----------|---------|
| **Cloudflare Pages** | Static React frontend hosting |
| **Cloudflare Workers** | Serverless API endpoints |
| **Cloudflare D1** | SQLite database for all persistent data |
| **Cloudflare KV** | Session storage, rate limiting, caching |
| **Cloudflare R2** | Static assets (optional) |
| **YouTube oEmbed** | Video metadata extraction |

---

## 📊 Database Schema (Cloudflare D1)

```sql
-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    email_verified INTEGER DEFAULT 0,
    password_hash TEXT,  -- NULL for OAuth users
    name TEXT,
    auth_provider TEXT DEFAULT 'email',  -- 'email' or 'google'
    google_id TEXT UNIQUE,
    is_admin INTEGER DEFAULT 0,
    daily_upload_count INTEGER DEFAULT 0,
    daily_upload_reset_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_active_at TEXT DEFAULT (datetime('now')),
    visibility_unlocked_at TEXT  -- For new account visibility threshold
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_google_id ON users(google_id);

-- ============================================
-- CATEGORIES TABLE
-- ============================================
CREATE TABLE categories (
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
CREATE TABLE subcategories (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(category_id, name)
);

CREATE INDEX idx_subcategories_category ON subcategories(category_id);

-- ============================================
-- VIDEOS TABLE
-- ============================================
CREATE TABLE videos (
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
    rating_sum REAL DEFAULT 0,  -- For efficient average calculation
    view_count INTEGER DEFAULT 0,  -- Internal platform views
    is_visible INTEGER DEFAULT 1,
    is_flagged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_rated_at TEXT
);

CREATE INDEX idx_videos_youtube_id ON videos(youtube_id);
CREATE INDEX idx_videos_category ON videos(category_id);
CREATE INDEX idx_videos_subcategory ON videos(subcategory_id);
CREATE INDEX idx_videos_created_at ON videos(created_at DESC);
CREATE INDEX idx_videos_avg_rating ON videos(avg_rating DESC);
CREATE INDEX idx_videos_discovery ON videos(is_visible, created_at DESC, avg_rating DESC);

-- ============================================
-- VIDEO TAGS TABLE
-- ============================================
CREATE TABLE video_tags (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, tag)
);

CREATE INDEX idx_video_tags_tag ON video_tags(tag);

-- ============================================
-- RATINGS TABLE
-- ============================================
CREATE TABLE ratings (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating >= 0 AND rating <= 10),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(video_id, user_id)
);

CREATE INDEX idx_ratings_video ON ratings(video_id);
CREATE INDEX idx_ratings_user ON ratings(user_id);

-- ============================================
-- USER SEEN VIDEOS (for loop prevention)
-- ============================================
CREATE TABLE user_seen_videos (
    user_id TEXT NOT NULL REFERENCES users(id),
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    seen_at TEXT DEFAULT (datetime('now')),
    interaction_type TEXT DEFAULT 'view',  -- 'view', 'rated', 'dismissed'
    PRIMARY KEY (user_id, video_id)
);

CREATE INDEX idx_seen_videos_user ON user_seen_videos(user_id, seen_at DESC);

-- ============================================
-- ALGORITHM PARAMETERS TABLE
-- ============================================
CREATE TABLE algorithm_params (
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

-- Insert default parameters
INSERT INTO algorithm_params (id) VALUES ('default');

-- ============================================
-- SPAM CONFIGURATION TABLE
-- ============================================
CREATE TABLE spam_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    daily_upload_limit INTEGER DEFAULT 5,
    duplicate_window_hours INTEGER DEFAULT 24,
    min_account_age_hours INTEGER DEFAULT 24,
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO spam_config (id) VALUES ('default');

-- ============================================
-- EMAIL VERIFICATION TOKENS
-- ============================================
CREATE TABLE email_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,  -- 'verify' or 'reset'
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);

-- ============================================
-- AUDIT LOG (for admin)
-- ============================================
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    user_id TEXT REFERENCES users(id),
    details TEXT,  -- JSON
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
```

---

## 🧠 Discovery Algorithm

### Core Philosophy

The algorithm is designed to be **intelligent but non-invasive**. It doesn't track:
- Watch time or completion rate
- Scroll behavior
- Click patterns beyond explicit actions

### Scoring Formula

```javascript
// Discovery Score Calculation
function calculateDiscoveryScore(video, user, params) {
    // 1. Freshness Score (0-1)
    // Exponential decay over 7 days
    const ageInDays = (Date.now() - video.createdAt) / (1000 * 60 * 60 * 24);
    const freshnessScore = Math.exp(-ageInDays / 7);

    // 2. Quality Score (0-1)
    // Normalized average rating with confidence adjustment
    const qualityScore = video.avgRating / 10;
    const confidenceMultiplier = Math.min(video.ratingCount / 20, 1);
    const adjustedQuality = qualityScore * (0.5 + 0.5 * confidenceMultiplier);

    // 3. Popularity Score (0-1)
    // Logarithmic scaling to prevent dominance
    const popularityScore = Math.min(Math.log10(video.ratingCount + 1) / 2, 1);

    // 4. Randomness Factor (0-1)
    // Seeded random for controlled variety
    const randomSeed = hashCode(video.id + user.sessionSeed);
    const randomScore = (Math.sin(randomSeed) + 1) / 2;

    // 5. Seen Penalty (0-1)
    // Time-decayed suppression of seen content
    let seenPenalty = 1;
    if (user.seenVideos.has(video.id)) {
        const daysSinceSeen = user.seenVideos.get(video.id);
        seenPenalty = Math.min(daysSinceSeen / params.seenDecayDays, 1);
        seenPenalty *= params.seenSuppressionStrength;
    }

    // Weighted combination
    const baseScore =
        freshnessScore * params.freshnessWeight +
        adjustedQuality * params.qualityWeight +
        popularityScore * params.popularityWeight +
        randomScore * params.randomnessFactor;

    return baseScore * seenPenalty;
}
```

### Loop Prevention Strategy

```javascript
// Multi-tier suppression system
class LoopPrevention {
    constructor() {
        this.recentlyShown = new LRUCache(50);  // Last 50 shown
        this.ratedVideos = new Set();            // Never repeat rated
        this.sessionSeed = Math.random();        // Refresh = new variety
    }

    filterForDiscovery(videos, pageNumber) {
        return videos
            .filter(v => !this.ratedVideos.has(v.id))  // Hard filter rated
            .map(v => ({
                ...v,
                penalty: this.calculatePenalty(v, pageNumber)
            }))
            .sort((a, b) => b.score * b.penalty - a.score * a.penalty)
            .slice(0, 20);
    }

    calculatePenalty(video, pageNumber) {
        // Tier 1: Recently shown (this session)
        if (this.recentlyShown.has(video.id)) {
            const showCount = this.recentlyShown.get(video.id);
            return Math.pow(0.3, showCount);  // Heavy penalty
        }

        // Tier 2: Seen in past sessions (from DB)
        if (video.seenAt) {
            const daysSince = daysBetween(video.seenAt, new Date());
            return Math.min(daysSince / 14, 1);  // Full recovery in 14 days
        }

        return 1;  // No penalty
    }

    markAsShown(videoId) {
        const count = this.recentlyShown.get(videoId) || 0;
        this.recentlyShown.set(videoId, count + 1);
    }
}
```

### Category-Aware Diversity

```javascript
function ensureCategoryDiversity(scoredVideos, targetCount = 20) {
    const result = [];
    const categoryQuotas = {};

    // Calculate fair distribution
    const uniqueCategories = [...new Set(scoredVideos.map(v => v.categoryId))];
    const baseQuota = Math.ceil(targetCount / uniqueCategories.length);

    // Greedy selection with quota enforcement
    const sorted = [...scoredVideos].sort((a, b) => b.score - a.score);

    for (const video of sorted) {
        if (result.length >= targetCount) break;

        const catCount = categoryQuotas[video.categoryId] || 0;

        // Allow 1.5x quota for high-scoring videos
        if (catCount < baseQuota * 1.5) {
            result.push(video);
            categoryQuotas[video.categoryId] = catCount + 1;
        }
    }

    return result;
}
```

---

## 🔐 Authentication System

### Email + Password Flow

```javascript
// Worker: /api/auth/register
export async function handleRegister(request, env) {
    const { email, password, name } = await request.json();

    // Validation
    if (!isValidEmail(email)) {
        return jsonResponse({ error: 'Invalid email' }, 400);
    }

    if (password.length < 8) {
        return jsonResponse({ error: 'Password too short' }, 400);
    }

    // Check existing
    const existing = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();

    if (existing) {
        return jsonResponse({ error: 'Email already registered' }, 409);
    }

    // Create user
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const visibilityUnlockedAt = new Date(
        Date.now() + 24 * 60 * 60 * 1000
    ).toISOString();

    await env.DB.prepare(`
        INSERT INTO users (id, email, password_hash, name, visibility_unlocked_at)
        VALUES (?, ?, ?, ?, ?)
    `).bind(userId, email, passwordHash, name, visibilityUnlockedAt).run();

    // Send verification email
    const token = crypto.randomUUID();
    await env.DB.prepare(`
        INSERT INTO email_tokens (token, user_id, type, expires_at)
        VALUES (?, ?, 'verify', datetime('now', '+24 hours'))
    `).bind(token, userId).run();

    await sendVerificationEmail(email, token, env);

    // Create session
    const session = await createSession(userId, env);

    return jsonResponse({
        user: { id: userId, email, name },
        sessionToken: session.token
    });
}
```

### Google OAuth Flow

```javascript
// Worker: /api/auth/google/callback
export async function handleGoogleCallback(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    // Exchange code for tokens
    const tokens = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
            grant_type: 'authorization_code'
        })
    }).then(r => r.json());

    // Get user info
    const userInfo = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
    }).then(r => r.json());

    // Find or create user
    let user = await env.DB.prepare(
        'SELECT * FROM users WHERE google_id = ?'
    ).bind(userInfo.id).first();

    if (!user) {
        const userId = crypto.randomUUID();
        await env.DB.prepare(`
            INSERT INTO users (id, email, google_id, name, auth_provider, email_verified)
            VALUES (?, ?, ?, ?, 'google', 1)
        `).bind(userId, userInfo.email, userInfo.id, userInfo.name).run();

        user = { id: userId, email: userInfo.email, name: userInfo.name };
    }

    const session = await createSession(user.id, env);

    // Redirect to app with session
    return Response.redirect(
        `${env.APP_URL}/?session=${session.token}`,
        302
    );
}
```

---

## 🛡️ Anti-Spam System

### Preventive Design

1. **No Text Fields** - Eliminates traditional spam vectors
2. **Video Validation** - Must be valid YouTube URLs
3. **Rate Limiting** - Per-user upload quotas
4. **New Account Throttling** - Visibility delay for new users

### Implementation

```javascript
// Middleware: Upload rate limiting
async function checkUploadLimits(userId, env) {
    const config = await env.DB.prepare(
        'SELECT * FROM spam_config WHERE id = ?'
    ).bind('default').first();

    const user = await env.DB.prepare(
        'SELECT daily_upload_count, daily_upload_reset_at FROM users WHERE id = ?'
    ).bind(userId).first();

    // Reset daily counter if needed
    const now = new Date();
    const resetAt = new Date(user.daily_upload_reset_at);

    if (now > resetAt) {
        await env.DB.prepare(`
            UPDATE users
            SET daily_upload_count = 0,
                daily_upload_reset_at = datetime('now', '+1 day')
            WHERE id = ?
        `).bind(userId).run();
        return { allowed: true, remaining: config.daily_upload_limit };
    }

    if (user.daily_upload_count >= config.daily_upload_limit) {
        return {
            allowed: false,
            remaining: 0,
            resetAt: user.daily_upload_reset_at
        };
    }

    return {
        allowed: true,
        remaining: config.daily_upload_limit - user.daily_upload_count
    };
}

// Duplicate detection
async function checkDuplicate(youtubeId, env) {
    const config = await env.DB.prepare(
        'SELECT duplicate_window_hours FROM spam_config WHERE id = ?'
    ).bind('default').first();

    const existing = await env.DB.prepare(`
        SELECT id FROM videos
        WHERE youtube_id = ?
        AND created_at > datetime('now', '-' || ? || ' hours')
    `).bind(youtubeId, config.duplicate_window_hours).first();

    return !!existing;
}
```

---

## 🚀 Cloudflare Deployment

### Project Structure

```
vidvault/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── context/
│   │   └── App.jsx
│   ├── public/
│   ├── package.json
│   └── vite.config.js
├── worker/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.js
│   │   │   ├── videos.js
│   │   │   ├── ratings.js
│   │   │   └── admin.js
│   │   ├── middleware/
│   │   │   ├── auth.js
│   │   │   └── rateLimit.js
│   │   ├── services/
│   │   │   ├── youtube.js
│   │   │   └── discovery.js
│   │   └── index.js
│   ├── wrangler.toml
│   └── package.json
├── schema.sql
└── README.md
```

### Wrangler Configuration

```toml
# worker/wrangler.toml
name = "vidvault-api"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
APP_URL = "https://vidvault.pages.dev"

[[d1_databases]]
binding = "DB"
database_name = "vidvault"
database_id = "your-database-id"

[[kv_namespaces]]
binding = "SESSIONS"
id = "your-kv-id"

[[kv_namespaces]]
binding = "CACHE"
id = "your-cache-kv-id"

[env.production]
vars = { APP_URL = "https://vidvault.app" }

[env.production.d1_databases]
binding = "DB"
database_name = "vidvault-prod"
database_id = "your-prod-database-id"
```

### Deployment Commands

```bash
# 1. Create D1 Database
wrangler d1 create vidvault
wrangler d1 execute vidvault --file=./schema.sql

# 2. Create KV Namespaces
wrangler kv:namespace create SESSIONS
wrangler kv:namespace create CACHE

# 3. Deploy Worker
cd worker
wrangler deploy

# 4. Build & Deploy Frontend
cd frontend
npm run build
wrangler pages deploy dist --project-name=vidvault

# 5. Configure Custom Domain (optional)
wrangler pages project vidvault
# Then configure in Cloudflare Dashboard
```

### Environment Variables

```bash
# Set secrets
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put JWT_SECRET
wrangler secret put EMAIL_API_KEY  # For Mailgun/Resend
```

---

## 🎨 Why VidVault Works

### Intelligent But Calm Design Philosophy

| Social Media Problem | VidVault Solution |
|----------------------|-------------------|
| Infinite scroll addiction | Loop-free discovery with "fresh picks" |
| Engagement farming | No comments, no follower counts |
| Algorithm manipulation | No watch-time tracking |
| Content chaos | Mandatory categorization |
| Spam & toxicity | No text input, automated limits |
| FOMO mechanics | No notifications, no viral triggers |

### The "internetisbeautiful" Spirit

1. **Single Purpose**: Discover interesting videos
2. **Respectful Design**: No dark patterns, no manipulation
3. **Technical Excellence**: Edge-native, fast, reliable
4. **Minimal Footprint**: Collects only essential data
5. **Transparent Algorithm**: Users understand why they see content

### Quality Over Engagement

The platform succeeds because it optimizes for **discovery satisfaction** rather than **time on site**:

- Users refresh when they want new content (not autoplay)
- Rating is a simple slider (not social pressure)
- Categories guide exploration (not algorithmic rabbit holes)
- Seen content fades naturally (not artificially repeated)

---

## 📄 API Reference

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/videos` | List videos (with discovery algorithm) |
| GET | `/api/videos/:id` | Get single video |
| GET | `/api/categories` | List all categories |
| GET | `/api/embed/:id` | Get embed data |

### Authenticated Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/videos` | Add new video |
| POST | `/api/ratings` | Rate a video |
| PUT | `/api/ratings/:videoId` | Update rating |
| GET | `/api/me/videos` | User's added videos |
| GET | `/api/me/ratings` | User's ratings |

### Admin Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Platform statistics |
| PUT | `/api/admin/algorithm` | Update algorithm params |
| PUT | `/api/admin/spam` | Update spam config |
| DELETE | `/api/admin/videos/:id` | Remove video |
| POST | `/api/admin/categories` | Add category |

---

## 🔮 Future Considerations

### Sustainable Revenue (Non-Intrusive)

- Optional "Curator" subscription for advanced features
- Anonymous, contextual sponsorships (e.g., "Today's picks powered by...")
- API access for third-party integrations

### Platform Evolution

- Browser extension for one-click video submission
- Mobile apps (React Native)
- Public API for embeddable discovery widgets
- Community-curated category spotlights

---

Built with ❤️ for calm, quality discovery.
