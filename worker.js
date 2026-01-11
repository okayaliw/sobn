/**
 * VidVault API - Cloudflare Worker
 * Edge-native serverless API for video discovery platform
 */

// ============================================
// CORS & Request Handling
// ============================================

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
        },
    });
}

function errorResponse(message, status = 400) {
    return jsonResponse({ error: message }, status);
}

// ============================================
// Authentication Utilities
// ============================================

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, hash) {
    const passwordHash = await hashPassword(password);
    return passwordHash === hash;
}

async function createJWT(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = btoa(JSON.stringify(header));
    const encodedPayload = btoa(JSON.stringify(payload));

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(`${encodedHeader}.${encodedPayload}`)
    );

    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJWT(token, secret) {
    try {
        const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );

        const signatureArray = Uint8Array.from(atob(encodedSignature), c => c.charCodeAt(0));
        const valid = await crypto.subtle.verify(
            'HMAC',
            key,
            signatureArray,
            encoder.encode(`${encodedHeader}.${encodedPayload}`)
        );

        if (!valid) return null;

        const payload = JSON.parse(atob(encodedPayload));
        if (payload.exp && Date.now() > payload.exp) return null;

        return payload;
    } catch {
        return null;
    }
}

async function getAuthUser(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7);
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload) return null;

    const user = await env.DB.prepare(
        'SELECT id, email, name, is_admin FROM users WHERE id = ?'
    ).bind(payload.userId).first();

    return user;
}

// ============================================
// YouTube Utilities
// ============================================

function extractYouTubeId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/shorts\/([^&\n?#]+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

async function fetchYouTubeMetadata(videoId) {
    // Using oEmbed API (no API key required)
    const response = await fetch(
        `https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${videoId}&format=json`
    );

    if (!response.ok) {
        throw new Error('Invalid YouTube video');
    }

    const data = await response.json();

    return {
        title: data.title,
        channelName: data.author_name,
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
}

// ============================================
// Discovery Algorithm
// ============================================

class DiscoveryEngine {
    constructor(db, params) {
        this.db = db;
        this.params = params;
    }

    async getVideos({ categoryId, subcategoryId, userId, page = 1, limit = 20, seed = 0 }) {
        // Get base videos
        let query = `
            SELECT
                v.*,
                c.name as category_name,
                c.icon as category_icon,
                s.name as subcategory_name
            FROM videos v
            JOIN categories c ON v.category_id = c.id
            LEFT JOIN subcategories s ON v.subcategory_id = s.id
            WHERE v.is_visible = 1
        `;

        const bindings = [];

        if (categoryId) {
            query += ' AND v.category_id = ?';
            bindings.push(categoryId);
        }

        if (subcategoryId) {
            query += ' AND v.subcategory_id = ?';
            bindings.push(subcategoryId);
        }

        // For new accounts, only show their own videos until visibility unlocks
        query += `
            AND (
                SELECT visibility_unlocked_at FROM users WHERE id = v.added_by_user_id
            ) <= datetime('now')
            OR v.added_by_user_id = ?
        `;
        bindings.push(userId || '');

        const videos = await this.db.prepare(query).bind(...bindings).all();

        // Get user's seen videos
        let seenVideos = new Map();
        if (userId) {
            const seen = await this.db.prepare(`
                SELECT video_id, seen_at FROM user_seen_videos
                WHERE user_id = ? AND seen_at > datetime('now', '-30 days')
            `).bind(userId).all();

            for (const row of seen.results) {
                const daysSince = (Date.now() - new Date(row.seen_at).getTime()) / (1000 * 60 * 60 * 24);
                seenVideos.set(row.video_id, daysSince);
            }
        }

        // Get user's ratings
        let ratedVideos = new Set();
        if (userId) {
            const rated = await this.db.prepare(
                'SELECT video_id FROM ratings WHERE user_id = ?'
            ).bind(userId).all();

            for (const row of rated.results) {
                ratedVideos.add(row.video_id);
            }
        }

        // Score and sort videos
        const scored = videos.results.map(video => ({
            ...video,
            score: this.calculateScore(video, seenVideos, seed),
            userRated: ratedVideos.has(video.id),
        }));

        // Filter out recently rated (hard filter)
        const filtered = scored.filter(v => !v.userRated || seenVideos.get(v.id) > 7);

        // Sort by score
        filtered.sort((a, b) => b.score - a.score);

        // Apply diversity filter
        const diverse = this.ensureDiversity(filtered, limit);

        // Paginate
        const offset = (page - 1) * limit;
        const paginated = diverse.slice(offset, offset + limit);

        return {
            videos: paginated,
            total: diverse.length,
            page,
            hasMore: offset + limit < diverse.length,
        };
    }

    calculateScore(video, seenVideos, seed) {
        // 1. Freshness Score
        const ageInDays = (Date.now() - new Date(video.created_at).getTime()) / (1000 * 60 * 60 * 24);
        const freshnessScore = Math.exp(-ageInDays / 7);

        // 2. Quality Score
        const qualityScore = video.avg_rating / 10;
        const confidenceMultiplier = Math.min(video.rating_count / 20, 1);
        const adjustedQuality = qualityScore * (0.5 + 0.5 * confidenceMultiplier);

        // 3. Popularity Score
        const popularityScore = Math.min(Math.log10(video.rating_count + 1) / 2, 1);

        // 4. Randomness Factor
        const randomSeed = this.hashCode(video.id + seed);
        const randomScore = (Math.sin(randomSeed) + 1) / 2;

        // 5. Seen Penalty
        let seenPenalty = 1;
        if (seenVideos.has(video.id)) {
            const daysSince = seenVideos.get(video.id);
            seenPenalty = Math.min(daysSince / this.params.seen_decay_days, 1);
            seenPenalty = 1 - (1 - seenPenalty) * this.params.seen_suppression_strength;
        }

        // Weighted combination
        const baseScore =
            freshnessScore * this.params.freshness_weight +
            adjustedQuality * this.params.quality_weight +
            popularityScore * this.params.popularity_weight +
            randomScore * this.params.randomness_factor;

        return baseScore * seenPenalty;
    }

    ensureDiversity(videos, targetCount) {
        const result = [];
        const categoryQuotas = {};

        const uniqueCategories = [...new Set(videos.map(v => v.category_id))];
        const baseQuota = Math.ceil(targetCount / Math.max(uniqueCategories.length, 1));

        for (const video of videos) {
            const catCount = categoryQuotas[video.category_id] || 0;

            if (catCount < baseQuota * 1.5) {
                result.push(video);
                categoryQuotas[video.category_id] = catCount + 1;
            }
        }

        // Fill remaining with highest scored
        if (result.length < targetCount) {
            const remaining = videos.filter(v => !result.includes(v));
            result.push(...remaining.slice(0, targetCount - result.length));
        }

        return result;
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }
}

// ============================================
// Route Handlers
// ============================================

// GET /api/videos
async function handleGetVideos(request, env) {
    const url = new URL(request.url);
    const categoryId = url.searchParams.get('category');
    const subcategoryId = url.searchParams.get('subcategory');
    const page = parseInt(url.searchParams.get('page') || '1');
    const seed = parseInt(url.searchParams.get('seed') || '0');

    const user = await getAuthUser(request, env);

    const params = await env.DB.prepare(
        'SELECT * FROM algorithm_params WHERE id = ?'
    ).bind('default').first();

    const engine = new DiscoveryEngine(env.DB, params);

    const result = await engine.getVideos({
        categoryId,
        subcategoryId,
        userId: user?.id,
        page,
        seed,
    });

    return jsonResponse(result);
}

// GET /api/videos/:id
async function handleGetVideo(request, env, videoId) {
    const video = await env.DB.prepare(`
        SELECT
            v.*,
            c.name as category_name,
            c.icon as category_icon,
            s.name as subcategory_name,
            u.name as added_by_name
        FROM videos v
        JOIN categories c ON v.category_id = c.id
        LEFT JOIN subcategories s ON v.subcategory_id = s.id
        JOIN users u ON v.added_by_user_id = u.id
        WHERE v.id = ?
    `).bind(videoId).first();

    if (!video) {
        return errorResponse('Video not found', 404);
    }

    // Get tags
    const tags = await env.DB.prepare(
        'SELECT tag FROM video_tags WHERE video_id = ?'
    ).bind(videoId).all();

    // Get user's rating if authenticated
    const user = await getAuthUser(request, env);
    let userRating = null;

    if (user) {
        const rating = await env.DB.prepare(
            'SELECT rating FROM ratings WHERE video_id = ? AND user_id = ?'
        ).bind(videoId, user.id).first();

        userRating = rating?.rating;

        // Mark as seen
        await env.DB.prepare(`
            INSERT OR REPLACE INTO user_seen_videos (user_id, video_id, seen_at)
            VALUES (?, ?, datetime('now'))
        `).bind(user.id, videoId).run();
    }

    return jsonResponse({
        ...video,
        tags: tags.results.map(t => t.tag),
        userRating,
    });
}

// POST /api/videos
async function handleCreateVideo(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) {
        return errorResponse('Authentication required', 401);
    }

    // Check upload limits
    const spamConfig = await env.DB.prepare(
        'SELECT * FROM spam_config WHERE id = ?'
    ).bind('default').first();

    const userData = await env.DB.prepare(
        'SELECT daily_upload_count, daily_upload_reset_at FROM users WHERE id = ?'
    ).bind(user.id).first();

    const now = new Date();
    const resetAt = new Date(userData.daily_upload_reset_at || 0);

    let uploadCount = userData.daily_upload_count || 0;

    if (now > resetAt) {
        uploadCount = 0;
        await env.DB.prepare(`
            UPDATE users SET daily_upload_count = 0, daily_upload_reset_at = datetime('now', '+1 day')
            WHERE id = ?
        `).bind(user.id).run();
    }

    if (uploadCount >= spamConfig.daily_upload_limit) {
        return errorResponse(`Daily upload limit (${spamConfig.daily_upload_limit}) reached`, 429);
    }

    const body = await request.json();
    const { url, categoryId, subcategoryId, tags } = body;

    // Extract YouTube ID
    const youtubeId = extractYouTubeId(url);
    if (!youtubeId) {
        return errorResponse('Invalid YouTube URL');
    }

    // Check for duplicates
    const duplicate = await env.DB.prepare(`
        SELECT id FROM videos WHERE youtube_id = ?
    `).bind(youtubeId).first();

    if (duplicate) {
        return errorResponse('This video has already been added');
    }

    // Fetch metadata
    let metadata;
    try {
        metadata = await fetchYouTubeMetadata(youtubeId);
    } catch (e) {
        return errorResponse('Could not fetch video information');
    }

    // Create video
    const videoId = crypto.randomUUID();

    await env.DB.prepare(`
        INSERT INTO videos (id, youtube_id, title, channel_name, thumbnail_url, category_id, subcategory_id, added_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        videoId,
        youtubeId,
        metadata.title,
        metadata.channelName,
        metadata.thumbnailUrl,
        categoryId,
        subcategoryId || null,
        user.id
    ).run();

    // Add tags
    if (tags && tags.length > 0) {
        for (const tag of tags.slice(0, 10)) {
            await env.DB.prepare(
                'INSERT INTO video_tags (video_id, tag) VALUES (?, ?)'
            ).bind(videoId, tag.toLowerCase().trim()).run();
        }
    }

    // Increment upload count
    await env.DB.prepare(
        'UPDATE users SET daily_upload_count = daily_upload_count + 1 WHERE id = ?'
    ).bind(user.id).run();

    return jsonResponse({ id: videoId, ...metadata }, 201);
}

// POST /api/ratings
async function handleCreateRating(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) {
        return errorResponse('Authentication required', 401);
    }

    const { videoId, rating } = await request.json();

    if (typeof rating !== 'number' || rating < 0 || rating > 10) {
        return errorResponse('Rating must be between 0 and 10');
    }

    // Check video exists
    const video = await env.DB.prepare(
        'SELECT id, rating_sum, rating_count FROM videos WHERE id = ?'
    ).bind(videoId).first();

    if (!video) {
        return errorResponse('Video not found', 404);
    }

    // Check existing rating
    const existing = await env.DB.prepare(
        'SELECT rating FROM ratings WHERE video_id = ? AND user_id = ?'
    ).bind(videoId, user.id).first();

    if (existing) {
        // Update existing rating
        const oldRating = existing.rating;
        const newSum = video.rating_sum - oldRating + rating;
        const newAvg = newSum / video.rating_count;

        await env.DB.batch([
            env.DB.prepare(
                'UPDATE ratings SET rating = ?, updated_at = datetime("now") WHERE video_id = ? AND user_id = ?'
            ).bind(rating, videoId, user.id),
            env.DB.prepare(
                'UPDATE videos SET rating_sum = ?, avg_rating = ?, last_rated_at = datetime("now") WHERE id = ?'
            ).bind(newSum, newAvg, videoId),
        ]);
    } else {
        // Create new rating
        const newCount = video.rating_count + 1;
        const newSum = video.rating_sum + rating;
        const newAvg = newSum / newCount;

        await env.DB.batch([
            env.DB.prepare(
                'INSERT INTO ratings (id, video_id, user_id, rating) VALUES (?, ?, ?, ?)'
            ).bind(crypto.randomUUID(), videoId, user.id, rating),
            env.DB.prepare(
                'UPDATE videos SET rating_sum = ?, rating_count = ?, avg_rating = ?, last_rated_at = datetime("now") WHERE id = ?'
            ).bind(newSum, newCount, newAvg, videoId),
        ]);
    }

    // Mark as seen with 'rated' type
    await env.DB.prepare(`
        INSERT OR REPLACE INTO user_seen_videos (user_id, video_id, seen_at, interaction_type)
        VALUES (?, ?, datetime('now'), 'rated')
    `).bind(user.id, videoId).run();

    return jsonResponse({ success: true, rating });
}

// GET /api/categories
async function handleGetCategories(request, env) {
    const categories = await env.DB.prepare(`
        SELECT c.*,
            (SELECT COUNT(*) FROM videos WHERE category_id = c.id AND is_visible = 1) as video_count
        FROM categories c
        WHERE c.is_active = 1
        ORDER BY c.sort_order
    `).all();

    // Get subcategories
    const result = [];
    for (const cat of categories.results) {
        const subcategories = await env.DB.prepare(`
            SELECT s.*,
                (SELECT COUNT(*) FROM videos WHERE subcategory_id = s.id AND is_visible = 1) as video_count
            FROM subcategories s
            WHERE s.category_id = ? AND s.is_active = 1
            ORDER BY s.sort_order
        `).bind(cat.id).all();

        result.push({
            ...cat,
            subcategories: subcategories.results,
        });
    }

    return jsonResponse(result);
}

// POST /api/auth/register
async function handleRegister(request, env) {
    const { email, password, name } = await request.json();

    if (!email || !password) {
        return errorResponse('Email and password required');
    }

    if (password.length < 8) {
        return errorResponse('Password must be at least 8 characters');
    }

    // Check existing
    const existing = await env.DB.prepare(
        'SELECT id FROM users WHERE email = ?'
    ).bind(email.toLowerCase()).first();

    if (existing) {
        return errorResponse('Email already registered', 409);
    }

    // Create user
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    await env.DB.prepare(`
        INSERT INTO users (id, email, password_hash, name, visibility_unlocked_at, daily_upload_reset_at)
        VALUES (?, ?, ?, ?, datetime('now', '+1 day'), datetime('now', '+1 day'))
    `).bind(userId, email.toLowerCase(), passwordHash, name || email.split('@')[0]).run();

    // Create token
    const token = await createJWT(
        { userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 },
        env.JWT_SECRET
    );

    return jsonResponse({
        user: { id: userId, email, name: name || email.split('@')[0] },
        token,
    }, 201);
}

// POST /api/auth/login
async function handleLogin(request, env) {
    const { email, password } = await request.json();

    const user = await env.DB.prepare(
        'SELECT * FROM users WHERE email = ?'
    ).bind(email.toLowerCase()).first();

    if (!user || !user.password_hash) {
        return errorResponse('Invalid credentials', 401);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
        return errorResponse('Invalid credentials', 401);
    }

    // Update last active
    await env.DB.prepare(
        'UPDATE users SET last_active_at = datetime("now") WHERE id = ?'
    ).bind(user.id).run();

    // Create token
    const token = await createJWT(
        { userId: user.id, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 },
        env.JWT_SECRET
    );

    return jsonResponse({
        user: { id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin },
        token,
    });
}

// GET /api/me
async function handleGetMe(request, env) {
    const user = await getAuthUser(request, env);
    if (!user) {
        return errorResponse('Authentication required', 401);
    }

    return jsonResponse(user);
}

// GET /api/admin/stats
async function handleGetAdminStats(request, env) {
    const user = await getAuthUser(request, env);
    if (!user?.is_admin) {
        return errorResponse('Admin access required', 403);
    }

    const stats = await env.DB.batch([
        env.DB.prepare('SELECT COUNT(*) as count FROM videos WHERE is_visible = 1'),
        env.DB.prepare('SELECT COUNT(*) as count FROM users'),
        env.DB.prepare('SELECT COUNT(*) as count FROM ratings'),
        env.DB.prepare('SELECT AVG(avg_rating) as avg FROM videos WHERE rating_count > 0'),
        env.DB.prepare('SELECT COUNT(*) as count FROM videos WHERE created_at > datetime("now", "-24 hours")'),
        env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE last_active_at > datetime("now", "-24 hours")'),
    ]);

    return jsonResponse({
        totalVideos: stats[0].results[0].count,
        totalUsers: stats[1].results[0].count,
        totalRatings: stats[2].results[0].count,
        averageRating: stats[3].results[0].avg?.toFixed(1) || '0.0',
        videosToday: stats[4].results[0].count,
        activeUsersToday: stats[5].results[0].count,
    });
}

// PUT /api/admin/algorithm
async function handleUpdateAlgorithm(request, env) {
    const user = await getAuthUser(request, env);
    if (!user?.is_admin) {
        return errorResponse('Admin access required', 403);
    }

    const params = await request.json();

    await env.DB.prepare(`
        UPDATE algorithm_params SET
            freshness_weight = ?,
            quality_weight = ?,
            popularity_weight = ?,
            randomness_factor = ?,
            seen_suppression_strength = ?,
            seen_decay_days = ?,
            updated_at = datetime('now')
        WHERE id = 'default'
    `).bind(
        params.freshnessWeight,
        params.qualityWeight,
        params.popularityWeight,
        params.randomnessFactor,
        params.seenSuppressionStrength,
        params.seenDecayDays
    ).run();

    return jsonResponse({ success: true });
}

// GET /api/embed/:id
async function handleGetEmbed(request, env, videoId) {
    const video = await env.DB.prepare(`
        SELECT v.*, c.name as category_name, c.icon as category_icon
        FROM videos v
        JOIN categories c ON v.category_id = c.id
        WHERE v.id = ? AND v.is_visible = 1
    `).bind(videoId).first();

    if (!video) {
        return errorResponse('Video not found', 404);
    }

    return jsonResponse({
        id: video.id,
        youtubeId: video.youtube_id,
        title: video.title,
        channel: video.channel_name,
        category: video.category_name,
        categoryIcon: video.category_icon,
        avgRating: video.avg_rating,
        ratingCount: video.rating_count,
    });
}

// ============================================
// Main Router
// ============================================

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        try {
            // Public routes
            if (method === 'GET' && path === '/api/videos') {
                return handleGetVideos(request, env);
            }

            if (method === 'GET' && path.match(/^\/api\/videos\/[\w-]+$/)) {
                const videoId = path.split('/')[3];
                return handleGetVideo(request, env, videoId);
            }

            if (method === 'GET' && path === '/api/categories') {
                return handleGetCategories(request, env);
            }

            if (method === 'GET' && path.match(/^\/api\/embed\/[\w-]+$/)) {
                const videoId = path.split('/')[3];
                return handleGetEmbed(request, env, videoId);
            }

            // Auth routes
            if (method === 'POST' && path === '/api/auth/register') {
                return handleRegister(request, env);
            }

            if (method === 'POST' && path === '/api/auth/login') {
                return handleLogin(request, env);
            }

            if (method === 'GET' && path === '/api/me') {
                return handleGetMe(request, env);
            }

            // Protected routes
            if (method === 'POST' && path === '/api/videos') {
                return handleCreateVideo(request, env);
            }

            if (method === 'POST' && path === '/api/ratings') {
                return handleCreateRating(request, env);
            }

            // Admin routes
            if (method === 'GET' && path === '/api/admin/stats') {
                return handleGetAdminStats(request, env);
            }

            if (method === 'PUT' && path === '/api/admin/algorithm') {
                return handleUpdateAlgorithm(request, env);
            }

            // 404
            return errorResponse('Not found', 404);

        } catch (error) {
            console.error('API Error:', error);
            return errorResponse('Internal server error', 500);
        }
    },
};
