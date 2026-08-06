require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize Firebase Admin SDK
const admin = require('firebase-admin');
try {
    admin.initializeApp({
        projectId: "yt-analyzer-4aa2d"
    });
} catch (e) {
    console.log('Firebase Admin init note:', e.message);
}

// Auth Middleware (Attaches user info if token provided)
const authenticateUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken;
        } catch (e) {
            console.log('Token verification note:', e.message);
        }
    }
    next();
};
app.use(authenticateUser);

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 1024 * 1024 * 1024 } });

const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, 'thumb-' + Date.now() + path.extname(file.originalname))
});
const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// In-memory job tracking (stores full result for chat context)
const jobs = {};
let youtubeAuthState = null;
let youtubeTokenStore = null;
let youtubeChannelCache = null;

function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

function isConfigured(value, placeholderHints = []) {
    if (!value || !String(value).trim()) return false;
    const normalized = String(value).toLowerCase();
    return !['your_', 'paste_', 'add_', 'replace_', 'client_id_here', 'client_secret_here', ...placeholderHints]
        .some(hint => normalized.includes(hint));
}

// ── Smart 20-Key Fallback Pool ──────────────────────────────────────────────
// Reads all GEMINI_API_KEY_1..20 + GEMINI_API_KEY, deduplicates, shuffles for
// balanced load distribution, so no single key gets rate-limited first.
const getApiKeys = () => {
    const raw = [];
    for (let i = 1; i <= 20; i++) {
        const k = process.env[`GEMINI_API_KEY_${i}`];
        if (k) raw.push(k.trim());
    }
    // Also support legacy single GEMINI_API_KEY
    if (process.env.GEMINI_API_KEY) raw.push(process.env.GEMINI_API_KEY.trim());

    // Deduplicate
    const seen = new Set();
    const unique = raw.filter(k => {
        if (!isConfigured(k, ['gemini_api_key_here']) || seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    // Shuffle for balanced load (Fisher-Yates)
    for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
    }
    return unique;
};

const getGroqApiKey = () => isConfigured(process.env.GROQ_API_KEY, ['groq_api_key_here']) ? process.env.GROQ_API_KEY.trim() : null;
const getGroqModel = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// ── Dedicated 4-Key Chat Pool (Gemini) ──────────────────────────────────────
const getChatKeys = () => {
    const raw = [];
    for (let i = 1; i <= 4; i++) {
        const k = process.env[`GEMINI_CHAT_KEY_${i}`];
        if (k) raw.push(k.trim());
    }
    const seen = new Set();
    return raw.filter(k => {
        if (!isConfigured(k, ['gemini_api_key_here']) || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
};

// ── Gemini Chat Runner (with fallback across 4 keys, then Groq) ─────────────
async function runGeminiChat(systemPrompt, userMessage, history) {
    const chatKeys = getChatKeys();
    const chatModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    for (const key of chatKeys) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
                model: chatModel,
                systemInstruction: systemPrompt
            });

            // Build history for Gemini multi-turn
            const geminiHistory = (history || []).map(h => ({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.content }]
            }));

            const chat = model.startChat({ history: geminiHistory });
            const result = await chat.sendMessage(userMessage);
            return { reply: result.response.text(), provider: 'gemini', model: chatModel };
        } catch (err) {
            const msg = err.message || '';
            // If quota or rate limit, try next key
            if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
                continue;
            }
            throw err;
        }
    }

    // Fallback to Groq if all Gemini chat keys fail
    const groqKey = getGroqApiKey();
    if (groqKey) {
        const reply = await runGroqChat(systemPrompt, userMessage, history || []);
        return { reply, provider: 'groq', model: getGroqModel() };
    }

    throw new Error('All chat API keys exhausted. Please try again later.');
}

function getYoutubeConfig() {
    return {
        clientId: isConfigured(process.env.GOOGLE_CLIENT_ID, ['google_client_id_here']) ? process.env.GOOGLE_CLIENT_ID.trim() : null,
        clientSecret: isConfigured(process.env.GOOGLE_CLIENT_SECRET, ['google_client_secret_here']) ? process.env.GOOGLE_CLIENT_SECRET.trim() : null,
        redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/youtube/oauth2callback`
    };
}

function isYoutubeConfigured() {
    const cfg = getYoutubeConfig();
    return Boolean(cfg.clientId && cfg.clientSecret);
}

function normalizeChatHistory(history = []) {
    return history
        .map(msg => ({
            role: msg.role === 'model' ? 'assistant' : msg.role,
            content: String(msg.content || '').slice(0, 2500)
        }))
        .filter(msg => ['user', 'assistant', 'system'].includes(msg.role) && msg.content);
}

async function runGroqChat(systemPrompt, message, history = [], maxTokens = 2000) {
    const apiKey = getGroqApiKey();
    if (!apiKey) throw new Error('No Groq API key configured. Add GROQ_API_KEY in .env and restart.');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: getGroqModel(),
            messages: [
                { role: 'system', content: systemPrompt },
                ...normalizeChatHistory(history),
                { role: 'user', content: String(message).slice(0, 3000) }
            ],
            temperature: 0.35,
            max_tokens: maxTokens
        })
    });

    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch { }
    if (!response.ok) {
        throw new Error(json.error?.message || text || 'Groq request failed.');
    }

    return json.choices?.[0]?.message?.content?.trim() || 'I could not generate a response.';
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { }
    if (!response.ok) {
        throw new Error(data.error_description || data.error?.message || text || `Request failed with ${response.status}`);
    }
    return data;
}

function parseIsoDuration(isoDuration = '') {
    const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const h = Number(match[1] || 0);
    const m = Number(match[2] || 0);
    const s = Number(match[3] || 0);
    return (h * 3600) + (m * 60) + s;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function getThumbnailDimensions(videoAspect, videoWidth, videoHeight) {
    const ratio = videoWidth && videoHeight ? videoWidth / videoHeight : null;
    const aspect = ratio ? (ratio < 0.85 ? '9:16' : ratio > 1.2 ? '16:9' : '1:1') : videoAspect;
    if (aspect === '9:16') return { width: 1080, height: 1920, aspect };
    if (aspect === '1:1') return { width: 1080, height: 1080, aspect };
    return { width: 1280, height: 720, aspect: '16:9' };
}

function buildThumbnailPrompt(basePrompt, aspect) {
    const formatText = aspect === '9:16'
        ? 'vertical 9:16 YouTube Shorts cover'
        : aspect === '1:1'
            ? 'square social video cover'
            : 'wide 16:9 YouTube thumbnail';
    return [
        basePrompt,
        `Create a ${formatText}.`,
        'Make it sharp, high contrast, clean, clickable, and not stretched.',
        'Keep faces and text natural, centered, readable, and inside safe margins.',
        'No warped bodies, no broken letters, no clutter, no watermark.'
    ].join(' ');
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function getYoutubeAccessToken() {
    if (!youtubeTokenStore) throw new Error('YouTube account is not linked yet.');
    const cfg = getYoutubeConfig();
    const expiresAt = youtubeTokenStore.expires_at || 0;
    if (expiresAt && Date.now() < expiresAt - 60000) return youtubeTokenStore.access_token;
    if (!youtubeTokenStore.refresh_token) throw new Error('YouTube session expired. Please link your account again.');

    const tokenData = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: youtubeTokenStore.refresh_token,
            grant_type: 'refresh_token'
        }).toString()
    });

    youtubeTokenStore = {
        ...youtubeTokenStore,
        ...tokenData,
        refresh_token: tokenData.refresh_token || youtubeTokenStore.refresh_token,
        expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
    };
    return youtubeTokenStore.access_token;
}

async function youtubeFetch(endpoint, query) {
    const accessToken = await getYoutubeAccessToken();
    const params = new URLSearchParams(query);
    return fetchJson(`https://www.googleapis.com/youtube/v3/${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
}

async function loadYoutubeChannelData(forceRefresh = false) {
    if (youtubeChannelCache && !forceRefresh) return youtubeChannelCache;

    const channelResponse = await youtubeFetch('channels', {
        part: 'snippet,statistics,contentDetails,brandingSettings',
        mine: 'true'
    });
    const channel = channelResponse.items?.[0];
    if (!channel) throw new Error('No YouTube channel found for this account.');

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    const videoLimitSetting = String(process.env.YOUTUBE_VIDEO_FETCH_LIMIT || '100').toLowerCase();
    const videoLimit = videoLimitSetting === 'all' ? Infinity : Math.max(1, Number(videoLimitSetting) || 100);
    const playlistItems = [];
    let pageToken = null;

    do {
        const page = await youtubeFetch('playlistItems', {
            part: 'snippet,contentDetails',
            playlistId: uploadsPlaylistId,
            maxResults: '50',
            ...(pageToken ? { pageToken } : {})
        });
        playlistItems.push(...(page.items || []));
        pageToken = page.nextPageToken;
    } while (pageToken && playlistItems.length < videoLimit);

    const selectedItems = playlistItems.slice(0, Number.isFinite(videoLimit) ? videoLimit : playlistItems.length);
    const ids = selectedItems.map(item => item.contentDetails?.videoId).filter(Boolean);
    const details = [];
    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const page = await youtubeFetch('videos', {
            part: 'snippet,statistics,contentDetails,status',
            id: chunk.join(',')
        });
        details.push(...(page.items || []));
    }

    const videos = details.map(video => {
        const durationSeconds = parseIsoDuration(video.contentDetails?.duration);
        const stats = video.statistics || {};
        const snippet = video.snippet || {};
        const isShort = durationSeconds > 0 && durationSeconds <= 60;
        return {
            id: video.id,
            title: snippet.title,
            description: (snippet.description || '').slice(0, 700),
            publishedAt: snippet.publishedAt,
            thumbnail: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
            url: `https://www.youtube.com/watch?v=${video.id}`,
            type: isShort ? 'Short' : 'Video',
            duration: formatDuration(durationSeconds),
            durationSeconds,
            viewCount: Number(stats.viewCount || 0),
            likeCount: Number(stats.likeCount || 0),
            commentCount: Number(stats.commentCount || 0),
            tags: snippet.tags || [],
            privacyStatus: video.status?.privacyStatus || 'unknown',
            uploadStatus: video.status?.uploadStatus || 'unknown'
        };
    }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const totalViews = videos.reduce((sum, video) => sum + video.viewCount, 0);
    const totalLikes = videos.reduce((sum, video) => sum + video.likeCount, 0);
    const totalComments = videos.reduce((sum, video) => sum + video.commentCount, 0);
    const shorts = videos.filter(video => video.type === 'Short');
    const longVideos = videos.filter(video => video.type === 'Video');
    const avg = list => list.length ? Math.round(list.reduce((sum, video) => sum + video.viewCount, 0) / list.length) : 0;
    const sortedByViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
    const dates = videos.map(video => new Date(video.publishedAt)).filter(date => !Number.isNaN(date.getTime()));
    const gaps = [];
    for (let i = 0; i < dates.length - 1; i++) {
        gaps.push(Math.abs(dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
    }
    const avgGapDays = gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null;

    const channelStats = channel.statistics || {};
    const summary = {
        totalVideosFetched: videos.length,
        shortsCount: shorts.length,
        videosCount: longVideos.length,
        totalViews,
        averageViews: videos.length ? Math.round(totalViews / videos.length) : 0,
        averageShortViews: avg(shorts),
        averageVideoViews: avg(longVideos),
        totalLikes,
        totalComments,
        engagementRate: totalViews ? Number((((totalLikes + totalComments) / totalViews) * 100).toFixed(2)) : 0,
        bestFormat: avg(shorts) > avg(longVideos) ? 'Shorts are pulling stronger views right now.' : 'Long videos are pulling stronger views right now.',
        uploadCadence: avgGapDays ? `About every ${avgGapDays} day${avgGapDays === 1 ? '' : 's'}` : 'Not enough uploads to calculate.',
        latestUpload: videos[0] || null,
        topVideos: sortedByViews.slice(0, 5),
        recentVideos: videos.slice(0, 12)
    };

    youtubeChannelCache = {
        linked: true,
        refreshedAt: new Date().toISOString(),
        fetchLimit: videoLimitSetting,
        channel: {
            id: channel.id,
            title: channel.snippet?.title || 'YouTube Channel',
            description: channel.snippet?.description || '',
            customUrl: channel.snippet?.customUrl || '',
            country: channel.snippet?.country || '',
            publishedAt: channel.snippet?.publishedAt || '',
            thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || '',
            banner: channel.brandingSettings?.image?.bannerExternalUrl || ''
        },
        statistics: {
            viewCount: Number(channelStats.viewCount || 0),
            subscriberCount: channelStats.hiddenSubscriberCount ? null : Number(channelStats.subscriberCount || 0),
            hiddenSubscriberCount: Boolean(channelStats.hiddenSubscriberCount),
            videoCount: Number(channelStats.videoCount || videos.length)
        },
        summary,
        videos
    };

    return youtubeChannelCache;
}

// ─────────────────────────────────────────────────────────────
app.get('/api/download-thumbnail', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Missing URL.');
    try {
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) throw new Error('Failed to fetch image.');
        res.setHeader('Content-Disposition', 'attachment; filename="youtube_thumbnail.jpg"');
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(Buffer.from(await imageRes.arrayBuffer()));
    } catch (err) {
        res.status(500).send('Error downloading image.');
    }
});

// ─────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    const keys = getApiKeys();
    res.json({
        ok: true,
        status: 'running',
        geminiApiKeyConfigured: keys.length > 0,
        keysCount: keys.length,
        groqConfigured: Boolean(getGroqApiKey()),
        youtubeConfigured: isYoutubeConfigured(),
        youtubeLinked: Boolean(youtubeTokenStore)
    });
});

// ─────────────────────────────────────────────────────────────
app.post('/api/analyze', uploadVideo.single('video'), async (req, res) => {
    const keys = getApiKeys();
    if (keys.length === 0) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'No Gemini API Keys configured.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Please upload a video file.' });

    const jobId = generateJobId();
    jobs[jobId] = { id: jobId, status: 'uploading', progress: 10, logs: ['Processing video...', 'Video uploaded successfully'], result: null, error: null };

    const videoAspect = req.body.videoAspect || '16:9';
    const videoWidth = Number(req.body.videoWidth || 0);
    const videoHeight = Number(req.body.videoHeight || 0);
    res.json({ success: true, jobId });
    runAnalysisWorker(jobId, req.file.path, req.file.mimetype, req.file.originalname, videoAspect, videoWidth, videoHeight);
});

// ─────────────────────────────────────────────────────────────
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs[req.query.jobId || req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
});

// SSE Live Progress Streaming Endpoint
app.get('/api/job/:jobId/stream', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];
    if (!job) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let sendIndex = 0;
    const timer = setInterval(() => {
        if (!jobs[jobId]) { clearInterval(timer); return res.end(); }
        const currentLogs = jobs[jobId].logs || [];
        if (currentLogs.length > sendIndex) {
            for (let i = sendIndex; i < currentLogs.length; i++) {
                res.write(`data: ${JSON.stringify({ log: currentLogs[i], progress: jobs[jobId].progress, status: jobs[jobId].status })}\n\n`);
            }
            sendIndex = currentLogs.length;
        }
        if (jobs[jobId].status === 'completed' || jobs[jobId].status === 'failed') {
            res.write(`data: ${JSON.stringify({ type: 'done', status: jobs[jobId].status, result: jobs[jobId].result, videoPath: jobs[jobId].videoPath })}\n\n`);
            clearInterval(timer);
            res.end();
        }
    }, 300);

    req.on('close', () => clearInterval(timer));
});



// ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    const { jobId, message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided.' });

    const job = jobs[jobId];
    const analysisContext = job && job.result ? JSON.stringify(job.result) : null;

    const systemPrompt = `You are an expert YouTube content advisor and AI video coach with deep knowledge of the YouTube algorithm, content creation, SEO, and audience psychology. 
${analysisContext ? `You have already performed a full AI analysis on the user's video. Here is the complete analysis data in JSON format:\n\n${analysisContext.substring(0, 8000)}\n\n` : ''}
Based on this analysis and your expertise, answer the user's question.

CRITICAL RESPONSE RULES:
1. Reply in short bullet points only.
2. Keep each bullet 1 to 2 lines.
3. Give deep, useful guidance, but do not write long paragraphs.
4. Use simple Hinglish or English matching the user's language.
5. Use timestamps and exact analysis data whenever helpful.
6. If you mention YouTube's algorithm, explain it as a practical simulation based on public signals, not private internal data.`;

    try {
        const { reply, provider, model } = await runGeminiChat(systemPrompt, message, history || []);
        res.json({ reply, provider, model });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
app.get('/api/youtube/auth-url', (req, res) => {
    if (!isYoutubeConfigured()) {
        return res.status(400).json({ error: 'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env, then restart.' });
    }

    const cfg = getYoutubeConfig();
    youtubeAuthState = crypto.randomBytes(18).toString('hex');
    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: youtubeAuthState
    });

    res.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

app.get('/api/youtube/oauth2callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
        return res.send(`<html><body><h3>YouTube linking failed</h3><p>${escapeHtml(error)}</p></body></html>`);
    }
    if (!code || !state || state !== youtubeAuthState) {
        return res.status(400).send('<html><body><h3>Invalid YouTube login request.</h3></body></html>');
    }

    try {
        const cfg = getYoutubeConfig();
        const tokenData = await fetchJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                redirect_uri: cfg.redirectUri,
                grant_type: 'authorization_code'
            }).toString()
        });

        youtubeTokenStore = {
            ...tokenData,
            expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
        };
        youtubeChannelCache = null;
        youtubeAuthState = null;

        res.send(`<!doctype html>
<html>
<head><title>YouTube Linked</title></head>
<body style="font-family:Arial,sans-serif;background:#0f1115;color:#fff;display:grid;place-items:center;min-height:100vh;">
    <div style="text-align:center;">
        <h2>YouTube account linked successfully.</h2>
        <p>You can close this window.</p>
    </div>
    <script>
        if (window.opener) window.opener.postMessage({ type: 'youtube-linked' }, window.location.origin);
        setTimeout(() => window.close(), 700);
    </script>
</body>
</html>`);
    } catch (err) {
        res.status(500).send(`<html><body><h3>YouTube linking failed</h3><p>${escapeHtml(err.message)}</p></body></html>`);
    }
});

app.get('/api/youtube/channel', async (req, res) => {
    if (!youtubeTokenStore) {
        return res.status(401).json({ error: 'YouTube account is not linked yet.' });
    }
    try {
        const data = await loadYoutubeChannelData(req.query.refresh === '1');
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/youtube/disconnect', (req, res) => {
    youtubeTokenStore = null;
    youtubeChannelCache = null;
    youtubeAuthState = null;
    res.json({ success: true });
});

app.post('/api/channel-chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided.' });
    if (!youtubeTokenStore) return res.status(401).json({ error: 'YouTube account is not linked yet.' });

    try {
        const channelData = await loadYoutubeChannelData(false);
        const compactContext = JSON.stringify({
            channel: channelData.channel,
            statistics: channelData.statistics,
            summary: channelData.summary,
            videos: channelData.videos.slice(0, 30).map(video => ({
                title: video.title,
                type: video.type,
                views: video.viewCount,
                likes: video.likeCount,
                comments: video.commentCount,
                duration: video.duration,
                publishedAt: video.publishedAt,
                url: video.url
            }))
        });

        const systemPrompt = `You are a practical YouTube channel growth coach. The user linked their real YouTube account and this is the channel data:\n\n${compactContext.substring(0, 12000)}\n\nResponse rules: use short bullet points, simple Hinglish/English, give direct actions, compare videos using real stats, and avoid long paragraphs. If data is missing, say exactly what is missing.`;
        const chatResult = await runGeminiChat(systemPrompt, message, history || []);
        res.json({ reply: chatResult.reply, provider: chatResult.provider, model: chatResult.model });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
app.post('/api/analyze-thumbnail', uploadImage.single('thumbnail'), async (req, res) => {
    const keys = getApiKeys();
    if (keys.length === 0) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'No API keys.' }); }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

    const localPath = req.file.path;
    try {
        const fileManager = new GoogleAIFileManager(keys[0]);
        const genAI = new GoogleGenerativeAI(keys[0]);

        const uploadResult = await fileManager.uploadFile(localPath, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        let fileState = await fileManager.getFile(uploadResult.file.name);
        let attempts = 0;
        while (fileState.state === "PROCESSING" && attempts < 20) {
            await new Promise(r => setTimeout(r, 2000));
            fileState = await fileManager.getFile(uploadResult.file.name);
            attempts++;
        }
        if (fileState.state !== "ACTIVE") throw new Error('Thumbnail processing failed.');

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } }, { text: `Analyze this YouTube thumbnail and return ONLY raw JSON (no markdown). 
CRITICAL RULE: For all text fields, strengths, weaknesses, improvements, and descriptions, write in clear, short statements (about 1 to 2 lines per statement) using very simple and easy English. Do not use hard or complex words. Make everything very clear and easy to understand.

Follow this exact structure:
{"thumbnailScore":82,"ctRPotential":"High","strengths":["s1","s2"],"weaknesses":["w1"],"improvements":["i1","i2"],"colorAnalysis":"...","textAnalysis":"...","emotionImpact":"...","facePresence":"...","overallVerdict":"...","heatmapZones":[{"zone":"top-left","focus":"Low","reason":"..."},{"zone":"center","focus":"High","reason":"..."},{"zone":"top-right","focus":"Medium","reason":"..."}]}` }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const parsed = JSON.parse(result.response.text());
        try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) { }
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        res.json({ success: true, data: parsed });
    } catch (err) {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        res.status(500).json({ error: err.message });
    }
});

function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        const safeInputPath = inputPath.replace(/\\/g, '/');
        const safeOutputPath = outputPath.replace(/\\/g, '/');
        const cmd = `ffmpeg -y -i "${safeInputPath}" -vf "scale=-2:360" -r 10 -c:v libx264 -crf 28 -preset ultrafast -c:a aac -b:a 64k "${safeOutputPath}"`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('[Compression] FFmpeg error:', error.message);
                reject(error);
            } else {
                resolve(outputPath);
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────
async function runAnalysisWorker(jobId, localPath, mimeType, originalName, videoAspect, videoWidth = 0, videoHeight = 0) {
    const job = jobs[jobId];
    const keys = getApiKeys();
    const isShorts = videoAspect === '9:16';
    const thumbnailSize = getThumbnailDimensions(videoAspect, videoWidth, videoHeight);

    const modelNames = [];
    if (process.env.GEMINI_MODEL) modelNames.push(process.env.GEMINI_MODEL);
    modelNames.push("gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.0-flash-lite");
    const uniqueModelNames = [...new Set(modelNames)];

    const prompt = `You are an elite YouTube AI analyst and content coach. Perform the most comprehensive possible analysis of this ${isShorts ? 'YouTube Short' : 'YouTube Video'}. Watch every frame, listen to all audio, transcribe all speech, detect emotions and faces, analyze pacing, editing style, storytelling, humor, visual quality, and everything else.

Also run a realistic YouTube recommendation-system simulation using public creator guidance and observable ranking signals. You do not have access to YouTube's private internal algorithm, so never claim that. Simulate how the video may perform across seed audience testing, CTR, retention, satisfaction, engagement, freshness, topic-match, personalization fit, safety, and rewatch/share signals.

Return ONLY a raw JSON object (absolutely no markdown, no backticks).

CRITICAL RULE FOR ALL TEXT FIELDS, STRATEGIES, REASONINGS, TITLES, DESCRIPTIONS, SUGGESTIONS, AND FEEDBACK:
1. Write useful, deep feedback, but in short scannable points.
2. Each point should be 1 to 2 lines, never a long paragraph.
3. Use simple English or Hinglish-style wording that a beginner can understand.
4. Prefer arrays of short points when a field needs multiple ideas.
5. Keep the information complete, but compact.

Follow this exact structure:

{
  "rating": 8.5,
  "viewsPotential": "High",
  "viewsReasoning": "Detailed reasoning",

  "feedback": {
    "visualQuality": "Detailed visual audit",
    "audioQuality": "Detailed audio audit",
    "hook": "Hook assessment (first 3-10 seconds)",
    "editingStyle": "Pacing, cuts, transitions assessment",
    "improvementSuggestions": ["Improvement 1", "Improvement 2", "Improvement 3"]
  },

  "viralScore": { "overall": 78, "entertainment": 80, "watchability": 75, "shareability": 70, "engagementPotential": 82 },

  "hookAnalysis": {
    "rating": 7,
    "hookText": "What appears/is said in first 5 seconds",
    "retentionPrediction": "Predicted % watching past 10 seconds and why",
    "hookSuggestions": ["Hook idea 1", "Hook idea 2", "Hook idea 3"]
  },

  "retentionMap": [
    { "timestamp": "0:00-0:10", "riskLevel": "Low", "note": "Strong hook" },
    { "timestamp": "0:10-0:30", "riskLevel": "Medium", "note": "Pacing slows" }
  ],

  "emotionAnalysis": {
    "primaryEmotion": "Motivational",
    "toneBreakdown": { "funny": 10, "sad": 5, "motivational": 70, "exciting": 15 },
    "emotionalArc": "How emotion changes throughout the video"
  },

  "profanityDetection": {
    "isClean": true,
    "flaggedWords": [],
    "verdict": "Content is family-friendly"
  },

  "shortsAnalysis": {
    "isSuitable": true,
    "reasoning": "Why suitable or not for Shorts",
    "recommendedDuration": "Ideal duration"
  },

  "faceExpressionAnalysis": {
    "detected": true,
    "emotionalMoments": [
      { "timestamp": "0:05", "emotion": "Excited", "intensity": "High" },
      { "timestamp": "0:30", "emotion": "Serious", "intensity": "Medium" }
    ],
    "peakImpactMoment": "Timestamp and description of strongest facial expression moment",
    "suggestions": ["Suggestion to improve facial expression engagement 1", "Suggestion 2"]
  },

  "voiceEnergyAnalysis": {
    "overallEnergy": "High",
    "averageSpeakingSpeed": "Moderate (around 140 words per minute)",
    "monotoneSections": [
      { "timestamp": "0:15-0:30", "note": "Voice becomes flat here, lacks variation" }
    ],
    "recommendations": ["Be more expressive at 0:15", "Add vocal emphasis on key points"]
  },

  "silenceDetection": {
    "unnecessaryPauses": [
      { "timestamp": "0:08", "duration": "2 seconds", "suggestion": "Cut this pause" },
      { "timestamp": "0:45", "duration": "3 seconds", "suggestion": "Fill with music or cut" }
    ],
    "totalSilenceEstimate": "About 8% of video is unnecessary silence",
    "overallVerdict": "Verdict on silence quality"
  },

  "audioQualityDetailed": {
    "noiseLevel": "Low",
    "echoDetected": false,
    "clarityScore": 85,
    "microphoneQuality": "Good - sounds like a decent USB microphone",
    "backgroundMusicBalance": "Music is slightly too loud at 0:20",
    "recommendations": ["Recommendation 1", "Recommendation 2"]
  },

  "memePotential": {
    "score": 72,
    "clipSuggestions": [
      { "timestamp": "0:12-0:15", "description": "Funny reaction moment", "whyViral": "Relatable expression that works as a meme" },
      { "timestamp": "0:45-0:48", "description": "Unexpected moment", "whyViral": "Surprise element perfect for short clips" }
    ]
  },

  "highlightMoments": [
    { "timestamp": "0:05", "description": "Strong opening statement", "interestScore": 92 },
    { "timestamp": "0:30", "description": "Key insight revealed", "interestScore": 88 },
    { "timestamp": "1:00", "description": "Most engaging moment", "interestScore": 95 }
  ],

  "shortsClipSuggestions": [
    { "startTime": "0:00", "endTime": "0:30", "title": "Suggested Shorts title 1", "viralReason": "Strong hook + quick payoff" },
    { "startTime": "0:45", "endTime": "1:15", "title": "Suggested Shorts title 2", "viralReason": "High-energy moment" }
  ],

  "engagementPrediction": {
    "likes": "2K-5K",
    "comments": "100-300",
    "shares": "50-150",
    "subscribersGained": "20-80",
    "reasoning": "Why these numbers are predicted"
  },

  "replayMoments": [
    { "timestamp": "0:20", "description": "Moment viewers will replay", "reason": "Contains important information delivered quickly" },
    { "timestamp": "0:55", "description": "Another replay-worthy moment", "reason": "Funny/surprising" }
  ],

  "storytellingAnalysis": {
    "introduction": "Assessment of how the intro sets up the video",
    "conflict": "Is there a problem/conflict established?",
    "buildUp": "How tension or interest builds",
    "climax": "The peak moment and how effective it is",
    "ending": "How satisfying and strong the ending is",
    "overallArc": "Overall storytelling effectiveness score and assessment",
    "score": 7
  },

  "humorAnalysis": {
    "funniness": 65,
    "moments": [
      { "timestamp": "0:10", "type": "Relatable joke", "effectiveness": "High" },
      { "timestamp": "0:40", "type": "Self-deprecating humor", "effectiveness": "Medium" }
    ],
    "suggestions": ["Add a callback to the opening joke", "Use more visual comedy"]
  },

  "pacingAnalysis": {
    "overallPace": "Good",
    "tooFastSections": [
      { "timestamp": "0:30-0:35", "note": "Information delivered too fast here" }
    ],
    "tooSlowSections": [
      { "timestamp": "0:50-1:00", "note": "Video drags here, consider cutting" }
    ],
    "recommendations": ["Slow down at 0:30 for clarity", "Cut 0:50-0:55 to improve pacing"]
  },

  "visualQualityDetailed": {
    "lighting": "Good natural lighting, slightly overexposed on right side",
    "colorGrading": "Warm tones, consistent throughout",
    "cameraShake": "Minimal, stable footage",
    "sharpness": "Sharp and in focus",
    "overallAppeal": "Professional looking with minor improvements needed",
    "score": 82
  },

  "backgroundAnalysis": {
    "distractions": [
      { "description": "Clutter visible on left side of frame", "timestamp": "throughout" }
    ],
    "cleanlinessScore": 70,
    "suggestions": ["Remove items from left side", "Add branded background element"]
  },

  "cameraMovementAnalysis": {
    "stability": "Good",
    "excessiveMovements": [
      { "timestamp": "0:20", "description": "Sudden pan that is distracting" }
    ],
    "recommendations": ["Use a tripod for static shots", "Avoid handheld during main talking points"]
  },

  "editingStyleAnalysis": {
    "style": "Fast-paced",
    "characteristics": ["Jump cuts", "Text overlays", "Quick transitions"],
    "confidence": 88,
    "alternativeStyles": ["Could benefit from more cinematic B-roll cuts"]
  },

  "nicheDetector": {
    "primaryNiche": "Education",
    "secondaryNiche": "Tech",
    "confidence": 91,
    "subNiches": ["AI tools", "Productivity", "Self-improvement"],
    "monetizationFit": "High CPM niche"
  },

  "sponsorOpportunityScore": {
    "score": 78,
    "brandFriendliness": "High",
    "potentialBrands": ["Tech companies", "Online course platforms", "Productivity apps"],
    "reasoning": "Clean content, professional delivery, educated audience with high purchasing power"
  },

  "monetizationScore": {
    "cpmPotential": "High ($8-15 CPM estimated)",
    "advertiserFriendliness": "Fully monetizable",
    "revenueEstimate": "$15-80 per 10K views",
    "reasoning": "Tech/Education niche commands premium CPM rates"
  },

  "copyrightRisk": {
    "musicRisk": "Low",
    "visualRisk": "Low",
    "overallRisk": "Low",
    "warnings": [],
    "verdict": "Content appears safe from copyright claims"
  },

  "communityGuidelineRisk": {
    "riskLevel": "Very Low",
    "concerns": [],
    "demonetizationRisk": "Very Low",
    "verdict": "Content fully complies with YouTube community guidelines"
  },

  "similarCreatorAnalysis": {
    "creators": [
      { "name": "Similar Creator Style 1 (based on content type)", "strength": "Better thumbnail CTR", "weakness": "Less in-depth content" },
      { "name": "Similar Creator Style 2", "strength": "Stronger hooks", "weakness": "Less consistent uploads" }
    ],
    "differentiators": "What makes this creator unique",
    "competitiveEdge": "Potential competitive advantage"
  },

  "trendingTopicAnalysis": {
    "matchingTrends": ["Trend 1 this content relates to", "Trend 2"],
    "trendScore": 72,
    "opportunities": ["Could capitalize on trending topic X", "Timing with Y event"]
  },

  "futureTrendPrediction": {
    "upcomingTopics": ["Topic gaining momentum 1", "Topic gaining momentum 2"],
    "contentIdeas": ["Video idea based on upcoming trend 1", "Video idea 2"],
    "timeframe": "These trends expected to peak in next 2-4 weeks"
  },

  "aiVideoCoach": {
    "overallAssessment": "Comprehensive coaching assessment of this video in simple language",
    "topMistakes": ["Mistake 1 explained simply", "Mistake 2", "Mistake 3"],
    "improvementPlan": [
      { "step": 1, "action": "First thing to fix", "impact": "High", "effort": "Low" },
      { "step": 2, "action": "Second thing to fix", "impact": "Medium", "effort": "Medium" },
      { "step": 3, "action": "Third improvement", "impact": "High", "effort": "High" }
    ],
    "encouragement": "Positive note about what the creator is doing well"
  },

  "seriesPlanner": {
    "seriesTitle": "Suggested series name",
    "sequelIdeas": ["Part 2 idea", "Part 3 idea", "Spin-off idea"],
    "episodePlan": [
      { "episode": 1, "title": "This video (current)", "status": "Done" },
      { "episode": 2, "title": "Suggested next episode", "topic": "What to cover" },
      { "episode": 3, "title": "Episode 3 idea", "topic": "What to cover" }
    ]
  },

  "subscriberGrowthPrediction": {
    "thirtyDay": "50-200 subscribers if consistent",
    "ninetyDay": "200-800 subscribers with 3 videos/week",
    "oneYear": "2K-10K subscribers with consistent quality content",
    "reasoning": "Based on niche competitiveness, content quality, and upload frequency assumptions"
  },

  "aiContentCalendar": {
    "weeklyPlan": [
      { "day": "Monday", "contentIdea": "Content idea", "format": "Long video (10-15 min)" },
      { "day": "Wednesday", "contentIdea": "Content idea", "format": "Short (60 sec)" },
      { "day": "Friday", "contentIdea": "Content idea", "format": "Long video (8-12 min)" },
      { "day": "Saturday", "contentIdea": "Content idea", "format": "Short (30-45 sec)" }
    ],
    "consistency": "Recommended upload frequency for this niche"
  },

  "frameSummary": {
    "keyFrames": [
      { "timestamp": "0:00", "description": "Opening frame description", "significance": "Sets tone" },
      { "timestamp": "0:30", "description": "Key moment frame", "significance": "Most impactful visual" }
    ],
    "visualStorytelling": "Assessment of how well visuals tell the story"
  },

  "automaticSummary": {
    "shortSummary": "One paragraph summary of the entire video content",
    "detailedSummary": "Full detailed summary covering all main points discussed",
    "keyPoints": ["Key point 1", "Key point 2", "Key point 3"]
  },

  "aiImprovementScore": {
    "currentScore": 72,
    "potentialScore": 91,
    "improvementGap": 19,
    "keyChangesNeeded": ["Most impactful change 1", "Change 2", "Change 3"],
    "timeToImprove": "Estimated 2-3 hours of re-editing to reach potential score"
  },

  "transcript": "Full verbatim transcript of all speech in the video",
  "autoChapters": [
    { "timestamp": "0:00", "title": "Introduction" },
    { "timestamp": "0:30", "title": "Main Content" }
  ],
  "sceneList": [
    { "timestamp": "0:00-0:05", "description": "Scene description" }
  ],
  "scriptRewrite": "Complete viral-optimized rewrite of the script",
  "ctaSuggestions": ["CTA for likes", "CTA for comments", "CTA for subscribe"],
  "bRollSuggestions": [
    { "timestamp": "0:10", "suggestion": "B-roll idea" }
  ],
  "musicSuggestion": {
    "style": "Energetic",
    "reason": "Why this style fits",
    "examples": ["Style example 1", "Style example 2"]
  },
  "sfxSuggestions": [
    { "timestamp": "0:05", "effect": "Sound effect idea" }
  ],
  "subtitleHighlights": ["Key word 1", "Key word 2", "Key phrase"],

  "growthPrediction": {
    "worstCase": "500-1K views",
    "averageCase": "5K-15K views",
    "bestCase": "50K-200K views",
    "reasoning": "Why these ranges"
  },

  "uploadTiming": {
    "bestDay": "Friday",
    "bestTime": "5:00 PM - 8:00 PM IST",
    "countrySpecific": {
      "India": "5:00 PM - 9:00 PM IST",
      "USA": "2:00 PM - 5:00 PM EST",
      "UK": "6:00 PM - 9:00 PM GMT"
    },
    "reasoning": "Why these times"
  },

  "audienceType": {
    "primary": "Teens (13-24)",
    "secondary": "Young Adults (25-34)",
    "interests": ["Interest 1", "Interest 2"],
    "audienceProfile": "Detailed audience description"
  },

  "competitorInsights": {
    "similarChannelStyle": "What top channels in this niche do",
    "missingElements": ["Missing element 1", "Missing element 2"],
    "inspiredImprovements": ["Improvement 1", "Improvement 2"]
  },

  "abTitleTest": {
    "titleA": "First title option",
    "titleB": "Second title option",
    "predictedWinner": "A",
    "reasoning": "Why A wins"
  },

  "channelGrowthAdvice": {
    "futureVideoIdeas": ["Video idea 1", "Video idea 2", "Video idea 3"],
    "contentStrategy": "Channel growth strategy"
  },

  "metadata": {
    "titles": {
      "english": ["English Title 1 with emojis", "English Title 2 with emojis"],
      "hindi": ["Hindi/Hinglish Title 1 with emojis", "Hindi/Hinglish Title 2 with emojis"]
    },
    "descriptions": [
      "Description option 1 - clickbait style with emojis",
      "Description option 2 - value-packed with emojis",
      "Description option 3 - storytelling style with emojis",
      "Description option 4 - ultra-short Shorts style with emojis"
    ],
    "hashtags": {
      "list": [{ "tag": "#Tag1", "rank": 98 }, { "tag": "#Tag2", "rank": 87 }],
      "recommendedQuantity": "Use 3-5 hashtags"
    },
    "tags": {
      "list": ["Tag 1", "Tag 2", "Tag 3", "Tag 4", "Tag 5"],
      "recommendedQuantity": "Use 10-15 tags"
    }
  },

  "thumbnailPrompt": "Detailed production-grade thumbnail prompt for image generation",

  "algorithmSimulation": {
    "ctrScore": 85,
    "hookStrength": 80,
    "retentionRisk": "Low",
    "algorithmFeedback": "Short simulation summary based on public ranking signals",
    "seedAudienceTest": {
      "passChance": 78,
      "reason": "How likely the first test audience is to keep watching and engage"
    },
    "rankingSignals": {
      "thumbnailCtr": 82,
      "titleMatch": 76,
      "firstThirtySecondsRetention": 74,
      "averageViewDuration": 70,
      "viewerSatisfaction": 78,
      "engagementVelocity": 68,
      "rewatchPotential": 64,
      "sharePotential": 72,
      "topicDemand": 75,
      "freshness": 66,
      "policySafety": 94
    },
    "distributionStages": [
      { "stage": "Seed audience", "score": 78, "verdict": "Likely to pass because the hook is clear" },
      { "stage": "Broader similar viewers", "score": 70, "verdict": "Needs stronger retention after the first drop-off" },
      { "stage": "Browse and Suggested", "score": 64, "verdict": "Thumbnail and title must promise the exact payoff" },
      { "stage": "Search discovery", "score": 72, "verdict": "Good if keywords match the spoken topic and description" }
    ],
    "actionPriorities": [
      "Improve first 5 seconds so more viewers stay.",
      "Make title and thumbnail promise one clear benefit.",
      "Cut slow parts before the first major payoff.",
      "Add a comment question to increase early engagement."
    ]
  },

  "uploadStrategy": {
    "bestTime": "5:00 PM - 8:00 PM IST Weekdays",
    "thumbnailIdea": "Thumbnail description",
    "audienceTarget": "Target demographic",
    "uploadSteps": [
      "Step 1: Upload as Private first.",
      "Step 2: Add all tags before publishing.",
      "Step 3: Add description with 3 hashtags at the end.",
      "Step 4: Add custom thumbnail.",
      "Step 5: Add end screens and cards.",
      "Step 6: Pin a comment with a question to boost engagement.",
      "Step 7: Switch to Public at peak posting time."
    ]
  }
}`;

    let uploadPath = localPath;
    let isCompressed = false;
    const compressedPath = path.join(path.dirname(localPath), 'cmp-' + path.basename(localPath));

    try {
        const stats = fs.statSync(localPath);
        if (stats.size > 5 * 1024 * 1024) { // > 5MB
            job.logs.push('Compressing video for ultra-fast AI analysis...');
            job.progress = 15;
            await compressVideo(localPath, compressedPath);
            uploadPath = compressedPath;
            isCompressed = true;
            job.logs.push('Video compressed successfully (reduced file size for faster upload)');
        }
    } catch (e) {
        console.error('Video compression skipped/failed:', e.message);
        job.logs.push('Using original video file for analysis...');
    }

    let jsonResponse = null;
    let lastKeyError = null;

    for (let k = 0; k < keys.length; k++) {
        const apiKey = keys[k];
        let geminiFileName = null;

        try {
            const fileManager = new GoogleAIFileManager(apiKey);
            const genAI = new GoogleGenerativeAI(apiKey);

            job.status = 'processing';
            job.progress = 30;
            job.logs.push('Uploading video to AI processing engine...');

            const uploadMime = isCompressed ? 'video/mp4' : mimeType;
            const uploadResult = await fileManager.uploadFile(uploadPath, { mimeType: uploadMime, displayName: originalName });
            geminiFileName = uploadResult.file.name;
            job.logs.push('Video uploaded successfully');

            job.progress = 40;
            job.logs.push('Extracting video metadata (duration, resolution, upload date)...');

            let fileState = await fileManager.getFile(geminiFileName);
            let attempts = 0;
            while (fileState.state === "PROCESSING") {
                attempts++;
                await new Promise(r => setTimeout(r, 3000));
                fileState = await fileManager.getFile(geminiFileName);
                if (attempts % 3 === 0) job.logs.push('Detecting scene changes and key moments...');
            }

            if (fileState.state !== "ACTIVE") throw new Error(`Processing failed: ${fileState.state}`);
            job.logs.push('Video ready for full AI audit');

            const phases = [
                'Detecting emotions and tone...',
                'Measuring pacing and engagement patterns...',
                'Extracting topics, keywords, and hashtags...',
                'Identifying target audience...',
                'Predicting retention performance...',
                'Simulating YouTube recommendation signals...',
                'Checking CTR, watch time, satisfaction, and safety signals...',
                'Generating improvement suggestions...',
                'Preparing final report...'
            ];
            for (const phase of phases) {
                job.logs.push(phase);
                await new Promise(r => setTimeout(r, 600));
            }

            job.status = 'analyzing';
            job.progress = 70;

            let keySuccess = false;
            let generationError = null;

            for (const currentModelName of uniqueModelNames) {
                try {
                    if (uniqueModelNames.indexOf(currentModelName) > 0) {
                        await new Promise(r => setTimeout(r, 2500));
                    }

                    job.logs.push('Analyzing with VeerAlyze AI Engine...');
                    const model = genAI.getGenerativeModel({ model: currentModelName });

                    const result = await model.generateContent({
                        contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } }, { text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    });

                    jsonResponse = JSON.parse(result.response.text());

                    // Generate a thumbnail in the same format as the uploaded video/short.
                    if (jsonResponse.thumbnailPrompt) {
                        const enhancedPrompt = buildThumbnailPrompt(jsonResponse.thumbnailPrompt, thumbnailSize.aspect)
                            .replace(/[^\x20-\x7E]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        const seed = Math.floor(Math.random() * 100000);
                        jsonResponse.thumbnailImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(enhancedPrompt)}?width=${thumbnailSize.width}&height=${thumbnailSize.height}&nologo=true&enhance=true&safe=true&seed=${seed}`;
                        jsonResponse.videoAspect = thumbnailSize.aspect;
                        jsonResponse.thumbnailSize = { width: thumbnailSize.width, height: thumbnailSize.height };
                    }

                    job.logs.push('Analysis complete with VeerAlyze AI Engine!');
                    keySuccess = true;
                    break;
                } catch (err) {
                    generationError = err;
                    console.log(`VeerAlyze AI Model retry internal error: ${err.message.substring(0, 80)}`);
                }
            }

            if (geminiFileName) {
                try { await fileManager.deleteFile(geminiFileName); job.logs.push('VeerAlyze storage cleaned up.'); } catch (e) { }
            }

            if (keySuccess) break;
            else throw new Error(generationError ? generationError.message : 'All models failed.');

        } catch (err) {
            lastKeyError = err;
            console.error(`Key #${k + 1} failed internally: ${err.message}`);
        }
    }

    try {
        if (jsonResponse) {
            job.progress = 100;
            job.status = 'completed';
            job.result = jsonResponse;
            job.videoPath = '/uploads/' + path.basename(localPath);
            job.logs.push('Analysis completed');
            job.logs.push('Analysis completed successfully');
        } else {
            if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch(e){} }
            throw new Error('Analysis request timed out or models were temporarily busy.');
        }
    } catch (err) {
        if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch(e){} }
        job.status = 'failed';
        job.error = err.message;
        job.logs.push('Error: The VeerAlyze AI Engine is currently processing multiple requests. Please try again shortly.');
    }

    // Clean up local compressed file if it exists
    if (isCompressed && fs.existsSync(compressedPath)) {
        try { fs.unlinkSync(compressedPath); } catch (e) { }
    }
}

const getManusApiKey = () => {
    const key = process.env.MANUS_API_KEY;
    return key && key.trim() && !key.includes('your_') ? key.trim() : null;
};

async function callManusAI(messages, maxTokens = 2000) {
    const apiKey = getManusApiKey();
    if (!apiKey) throw new Error('Manus AI API key not configured. Add MANUS_API_KEY to .env');

    // Try OpenAI-compatible endpoint at api.manus.im with multiple auth strategies
    const endpoints = [
        { url: 'https://api.manus.im/v1/chat/completions', headers: { 'API_KEY': apiKey, 'Content-Type': 'application/json' } },
        { url: 'https://api.manus.im/v1/chat/completions', headers: { 'x-manus-api-key': apiKey, 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
        { url: 'https://api.manus.ai/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    ];

    let lastErr = null;
    for (const ep of endpoints) {
        try {
            const response = await fetch(ep.url, {
                method: 'POST',
                headers: ep.headers,
                body: JSON.stringify({
                    model: 'manus-2',
                    messages,
                    temperature: 0.7,
                    max_tokens: maxTokens,
                    stream: false
                })
            });

            const text = await response.text();
            let json = {};
            try { json = JSON.parse(text); } catch {}
            if (!response.ok) {
                lastErr = new Error(json.error?.message || text || `Manus AI request failed: ${response.status}`);
                continue; // Try next endpoint
            }
            const content = json.choices?.[0]?.message?.content?.trim();
            if (content) {
                console.log('Manus AI succeeded via:', ep.url);
                return content;
            }
            lastErr = new Error('No response content from Manus AI');
        } catch (fetchErr) {
            lastErr = fetchErr;
            continue; // Try next endpoint
        }
    }
    throw lastErr || new Error('All Manus AI endpoints failed');
}

async function callManusWithFallback(messages, maxTokens = 2000) {
    // Try Manus first, then fall back to Groq if Manus fails
    try {
        return await callManusAI(messages, maxTokens);
    } catch (manusErr) {
        console.log('Manus AI failed, falling back to Groq:', manusErr.message);
        // Fallback to Groq
        const sysMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');
        const lastUser = userMsgs[userMsgs.length - 1];
        const historyMsgs = userMsgs.slice(0, -1);
        return await runGroqChat(sysMsg?.content || '', lastUser?.content || '', historyMsgs, maxTokens);
    }
}

// ─────────────────────────────────────────────────────────────
//  MANUS-STYLE VIDEO EDITING AGENT
// ─────────────────────────────────────────────────────────────
// ==========================================
//  MANUS-STYLE AGENTIC VIDEO STUDIO ENGINE
// ==========================================
const { exec } = require('child_process');
const puppeteer = require('puppeteer');

// 1. Workspace Manager
function getWorkspaceFileList() {
    try {
        const files = fs.readdirSync(uploadDir);
        return files.map(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            const ext = path.extname(file).toLowerCase();
            let type = 'unknown';
            if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) type = 'video';
            else if (['.mp3', '.wav', '.ogg', '.m4a', '.aac'].includes(ext)) type = 'audio';
            else if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) type = 'image';
            else if (['.srt', '.vtt', '.txt'].includes(ext)) type = 'subtitle';
            return { name: file, type, size: stats.size };
        });
    } catch (e) {
        return [];
    }
}

// 2. Resilient Stock Fallback URLs matching keywords
function getStockFallbackVideo(query) {
    const q = String(query).toLowerCase();
    if (q.includes('cat') || q.includes('animal') || q.includes('pet')) {
        return 'https://assets.mixkit.co/videos/preview/mixkit-curious-cat-watching-something-4363-large.mp4';
    }
    if (q.includes('space') || q.includes('star') || q.includes('galaxy') || q.includes('sci-fi')) {
        return 'https://assets.mixkit.co/videos/preview/mixkit-stars-in-space-1611-large.mp4';
    }
    if (q.includes('nature') || q.includes('forest') || q.includes('tree') || q.includes('river')) {
        return 'https://assets.mixkit.co/videos/preview/mixkit-forest-stream-in-the-sunlight-529-large.mp4';
    }
    if (q.includes('city') || q.includes('street') || q.includes('traffic') || q.includes('car')) {
        return 'https://assets.mixkit.co/videos/preview/mixkit-city-traffic-at-night-aerial-view-31862-large.mp4';
    }
    return 'https://assets.mixkit.co/videos/preview/mixkit-abstract-laser-lights-background-31745-large.mp4';
}

function getStockFallbackAudio(query) {
    const q = String(query).toLowerCase();
    if (q.includes('funny') || q.includes('comedy') || q.includes('laugh')) {
        return 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3';
    }
    if (q.includes('chill') || q.includes('lofi') || q.includes('relax') || q.includes('study')) {
        return 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3';
    }
    return 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
}

// 3. Puppeteer Real-time Asset Acquisition (Browser / Search Tools)
async function searchAndDownloadAsset(query, assetType) {
    console.log('[Manus Agent] Searching web for asset: "' + query + '" of type: ' + assetType);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        let downloadUrl = null;
        const ext = assetType === 'audio' ? '.mp3' : (assetType === 'image' ? '.jpg' : '.mp4');
        
        if (assetType === 'video') {
            const searchUrl = 'https://pixabay.com/videos/search/' + encodeURIComponent(query) + '/';
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            const videoPageLink = await page.evaluate(() => {
                const linkEl = document.querySelector('a[href^="/videos/"]');
                return linkEl ? linkEl.href : null;
            });
            if (videoPageLink) {
                await page.goto(videoPageLink, { waitUntil: 'networkidle2', timeout: 30000 });
                downloadUrl = await page.evaluate(() => {
                    const videoEl = document.querySelector('video source') || document.querySelector('video');
                    return videoEl ? videoEl.src : null;
                });
            }
            if (!downloadUrl) {
                const pexelsUrl = 'https://www.pexels.com/search/videos/' + encodeURIComponent(query) + '/';
                await page.goto(pexelsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                downloadUrl = await page.evaluate(() => {
                    const videoSource = document.querySelector('video source') || document.querySelector('video');
                    return videoSource ? videoSource.src : null;
                });
            }
        } else if (assetType === 'image') {
            const searchUrl = 'https://pixabay.com/images/search/' + encodeURIComponent(query) + '/';
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            downloadUrl = await page.evaluate(() => {
                const img = document.querySelector('img[src*="/photo/"]');
                return img ? img.src : null;
            });
        } else if (assetType === 'audio') {
            const searchUrl = 'https://pixabay.com/music/search/' + encodeURIComponent(query) + '/';
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            downloadUrl = await page.evaluate(() => {
                const playBtn = document.querySelector('[data-mp3]');
                return playBtn ? playBtn.getAttribute('data-mp3') : null;
            });
        }
        
        await browser.close();
        
        if (!downloadUrl) {
            if (assetType === 'video') downloadUrl = getStockFallbackVideo(query);
            else if (assetType === 'audio') downloadUrl = getStockFallbackAudio(query);
            else downloadUrl = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(query) + '?width=1280&height=720&nologo=true';
        }
        
        console.log('[Manus Agent] Downloading asset from URL: ' + downloadUrl);
        const safeQuery = query.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const filename = 'asset-' + safeQuery + '-' + Date.now() + ext;
        const targetFilePath = path.join(uploadDir, filename);
        
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error('Fetch failed: ' + response.status);
        fs.writeFileSync(targetFilePath, Buffer.from(await response.arrayBuffer()));
        console.log('[Manus Agent] Download completed. Saved as ' + filename);
        return filename;

    } catch (err) {
        console.error('[Manus Agent] Puppeteer asset acquisition failed, using fallback:', err.message);
        if (browser) { try { await browser.close(); } catch(e){} }
        
        let fallbackUrl = '';
        const ext = assetType === 'audio' ? '.mp3' : (assetType === 'image' ? '.jpg' : '.mp4');
        if (assetType === 'video') fallbackUrl = getStockFallbackVideo(query);
        else if (assetType === 'audio') fallbackUrl = getStockFallbackAudio(query);
        else fallbackUrl = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(query) + '?width=1280&height=720&nologo=true';
        
        const safeQuery = query.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const filename = 'fallback-' + safeQuery + '-' + Date.now() + ext;
        const targetFilePath = path.join(uploadDir, filename);
        
        try {
            const response = await fetch(fallbackUrl);
            fs.writeFileSync(targetFilePath, Buffer.from(await response.arrayBuffer()));
            return filename;
        } catch (e) {
            console.error('[Manus Agent] Critical fallback download failed:', e.message);
            throw new Error('Failed to acquire asset "' + query + '": ' + err.message);
        }
    }
}

// 4. Advanced FFmpeg Graph Builder
function hasAudioStream(filePath) {
    return new Promise((resolve) => {
        const cmd = 'ffprobe -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1 "' + filePath + '"';
        exec(cmd, (err, stdout) => {
            resolve(!err && stdout.trim().length > 0);
        });
    });
}

async function editVideoWithStepsAgent(inputPath, outputPath, steps, queryToPath) {
    const hasAudio = await hasAudioStream(inputPath);
    console.log('[Manus Agent] Main video has audio stream: ' + hasAudio);
    const tempFiles = [];

    const inputs = [{ path: inputPath, loop: false }];
    const filterComplexParts = [];
    const assetToIndex = {};

    // Collect multi-inputs from steps
    for (const step of steps) {
        if (step.type === 'overlay' || step.type === 'audio_mix' || step.type === 'side_by_side') {
            const assetQuery = step.assetQuery || step.query;
            const filename = queryToPath[assetQuery] || assetQuery;
            if (filename) {
                const assetPath = path.isAbsolute(filename) ? filename : path.join(uploadDir, filename);
                if (fs.existsSync(assetPath)) {
                    let idx = inputs.findIndex(inp => inp.path === assetPath);
                    if (idx === -1) {
                        idx = inputs.length;
                        inputs.push({ path: assetPath, loop: step.type === 'audio_mix' && step.loop !== false });
                    }
                    assetToIndex[assetQuery] = idx;
                }
            }
        }
    }

    const vfStd = [];
    const afStd = [];
    const preInputArgs = [];
    const eqParams = {};
    let hasSpeed = false;
    let speedValue = 1.0;

    // Build standard filters
    for (const step of steps) {
        switch (step.type) {
            case 'color_filter':
                switch (step.filter) {
                    case 'grayscale': vfStd.push('hue=s=0'); break;
                    case 'sepia': vfStd.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'); break;
                    case 'vintage': vfStd.push('vignette=angle=0.4', 'colorchannelmixer=.3:.4:.3:0:.3:.4:.2:0:.2:.3:.3'); break;
                    case 'high_contrast': eqParams.contrast = 1.5; eqParams.brightness = 0.04; eqParams.saturation = 1.3; break;
                    case 'negative': vfStd.push('lutrgb=r=negval:g=negval:b=negval'); break;
                    case 'vibrant': eqParams.saturation = 2.0; eqParams.contrast = 1.15; break;
                    case 'warm': vfStd.push('colorbalance=rs=.15:gs=.05:bs=-.1:rm=.1:gm=.05:bm=-.05'); break;
                    case 'cool': vfStd.push('colorbalance=rs=-.1:gs=.0:bs=.15:rm=-.05:gm=.0:bm=.1'); break;
                    case 'cinematic': eqParams.contrast = 1.4; eqParams.brightness = -0.02; eqParams.saturation = 0.85; vfStd.push('vignette=angle=0.35'); break;
                }
                break;
            case 'brightness': eqParams.brightness = Math.max(-1, Math.min(1, Number(step.value) || 0)); break;
            case 'contrast': eqParams.contrast = Math.max(0.3, Math.min(3, Number(step.value) || 1)); break;
            case 'saturation': eqParams.saturation = Math.max(0, Math.min(3, Number(step.value) || 1)); break;
            case 'speed':
                speedValue = Math.max(0.5, Math.min(2.0, Number(step.value) || 1));
                hasSpeed = true;
                break;
            case 'audio_effect':
                if (hasAudio) {
                    switch (step.effect) {
                        case 'bass_boost': afStd.push('equalizer=f=60:width_type=o:width=2:g=8'); break;
                        case 'treble_boost': afStd.push('equalizer=f=3000:width_type=o:width=2:g=6'); break;
                        case 'volume_up': afStd.push('volume=' + (Number(step.value) || 1.5)); break;
                        case 'volume_down': afStd.push('volume=' + (Number(step.value) || 0.5)); break;
                        case 'mute': afStd.push('volume=0'); break;
                        case 'normalize': afStd.push('loudnorm'); break;
                        case 'echo': afStd.push('aecho=0.8:0.88:500:0.3'); break;
                    }
                }
                break;
            case 'vignette': vfStd.push('vignette=angle=' + (Number(step.angle) || 0.4)); break;
            case 'sharpen': vfStd.push('unsharp=5:5:1.5:5:5:0.0'); break;
            case 'blur': vfStd.push('boxblur=' + Math.max(1, Math.min(10, Number(step.value) || 3))); break;
            case 'fade_in':
                const fd = Math.max(0.3, Math.min(5, Number(step.duration) || 1));
                vfStd.push('fade=t=in:st=0:d=' + fd);
                if (hasAudio) afStd.push('afade=t=in:st=0:d=' + fd);
                break;
            case 'zoom':
                const z = Math.max(1.05, Math.min(2.0, Number(step.value) || 1.2));
                vfStd.push('scale=iw*' + z + ':ih*' + z + ':flags=lanczos,crop=iw/' + z + ':ih/' + z);
                break;
            case 'flip':
                if (step.direction === 'horizontal') vfStd.push('hflip');
                else if (step.direction === 'vertical') vfStd.push('vflip');
                break;
            case 'rotate':
                const angle = Number(step.angle) || 0;
                if (angle === 90) vfStd.push('transpose=1');
                else if (angle === 180) vfStd.push('transpose=1,transpose=1');
                else if (angle === 270) vfStd.push('transpose=2');
                break;
            case 'trim':
                if (step.start !== undefined && step.start !== null) preInputArgs.push('-ss', String(step.start));
                if (step.end !== undefined && step.end !== null) preInputArgs.push('-to', String(step.end));
                if (step.duration !== undefined && step.duration !== null) preInputArgs.push('-t', String(step.duration));
                break;
        }
    }

    if (Object.keys(eqParams).length > 0) {
        const eqParts = [];
        if (eqParams.contrast !== undefined) eqParts.push('contrast=' + eqParams.contrast);
        if (eqParams.brightness !== undefined) eqParts.push('brightness=' + eqParams.brightness);
        if (eqParams.saturation !== undefined) eqParts.push('saturation=' + eqParams.saturation);
        if (eqParts.length > 0) vfStd.unshift('eq=' + eqParts.join(':'));
    }

    if (hasSpeed && speedValue !== 1.0) {
        vfStd.push('setpts=PTS/' + speedValue);
        if (hasAudio) afStd.push('atempo=' + speedValue);
    }

    let currentV = '[0:v]';
    let currentA = hasAudio ? '[0:a]' : null;

    if (vfStd.length > 0) {
        filterComplexParts.push(currentV + vfStd.join(',') + '[v_std]');
        currentV = '[v_std]';
    }
    if (currentA && afStd.length > 0) {
        filterComplexParts.push(currentA + afStd.join(',') + '[a_std]');
        currentA = '[a_std]';
    }

    let overlayCount = 0;
    let audioMixCount = 0;

    for (const step of steps) {
        if (step.type === 'overlay') {
            const assetQuery = step.assetQuery || step.query;
            const idx = assetToIndex[assetQuery];
            if (idx !== undefined) {
                overlayCount++;
                const scaledOverlay = '[ov_scaled_' + overlayCount + ']';
                const scaleRes = step.scale || '320:240';
                filterComplexParts.push('[' + idx + ':v]scale=' + scaleRes + '[ov_scaled_' + overlayCount + ']');
                
                const x = step.x || '(W-w)/2';
                const y = step.y || '(H-h)/2';
                const start = step.startTime !== undefined ? Number(step.startTime) : 0;
                const duration = step.duration !== undefined ? Number(step.duration) : 99999;
                const enable = "enable='between(t," + start + "," + (start + duration) + ")'";
                
                const outV = '[v_overlay_' + overlayCount + ']';
                filterComplexParts.push(currentV + scaledOverlay + "overlay=x='" + x + "':y='" + y + "':" + enable + outV);
                currentV = outV;
            }
        } else if (step.type === 'side_by_side') {
            const assetQuery = step.assetQuery || step.query;
            const idx = assetToIndex[assetQuery];
            if (idx !== undefined) {
                overlayCount++;
                const outV = '[v_side_' + overlayCount + ']';
                filterComplexParts.push(currentV + 'scale=hd720[left_side]');
                filterComplexParts.push('[' + idx + ':v]scale=hd720[right_side]');
                filterComplexParts.push('[left_side][right_side]hstack=inputs=2' + outV);
                currentV = outV;
            }
        } else if (step.type === 'audio_mix') {
            const assetQuery = step.assetQuery || step.query;
            const idx = assetToIndex[assetQuery];
            if (idx !== undefined) {
                audioMixCount++;
                const vol = step.volume !== undefined ? step.volume : 0.3;
                const bgAudio = '[bg_audio_' + audioMixCount + ']';
                filterComplexParts.push('[' + idx + ':a]volume=' + vol + bgAudio);
                
                const outA = '[a_mixed_' + audioMixCount + ']';
                if (currentA) {
                    filterComplexParts.push(currentA + bgAudio + 'amix=inputs=2:duration=first:dropout_transition=2' + outA);
                    currentA = outA;
                } else {
                    filterComplexParts.push(bgAudio + 'anull' + outA);
                    currentA = outA;
                }
            }
        } else if (step.type === 'text_overlay' && step.text) {
            overlayCount++;
            
            // Fix Bug #1 & #7: Write text to a temp file to safely support ALL Unicode characters (Hindi, emojis, etc.)
            const tempTextFile = path.join(uploadDir, `temp_text_${Date.now()}_${Math.random().toString(36).substr(2,5)}.txt`);
            fs.writeFileSync(tempTextFile, String(step.text), 'utf8');
            if (typeof tempFiles !== 'undefined') tempFiles.push(tempTextFile);

            // Escape ONLY backslashes and colons for the textfile path itself in FFmpeg
            const escapedTempTextFile = tempTextFile.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

            const fontSize = Math.max(16, Math.min(96, Number(step.fontSize) || 42));
            const fontColor = step.fontColor || 'white';
            
            let x = '(w-text_w)/2';
            let y = '(h-text_h-30)';
            switch (step.position) {
                case 'top': x = '(w-text_w)/2'; y = '30'; break;
                case 'bottom': x = '(w-text_w)/2'; y = '(h-text_h-30)'; break;
                case 'top-left': x = '30'; y = '30'; break;
                case 'top-right': x = '(w-text_w-30)'; y = '30'; break;
                case 'bottom-left': x = '30'; y = '(h-text_h-30)'; break;
                case 'bottom-right': x = '(w-text_w-30)'; y = '(h-text_h-30)'; break;
                case 'center': x = '(w-text_w)/2'; y = '(h-text_h)/2'; break;
            }
            
            let alpha = '1';
            const start = step.startTime !== undefined ? Number(step.startTime) : 0;
            const duration = step.duration !== undefined ? Number(step.duration) : 99999;
            
            if (step.animation === 'fade') {
                alpha = "if(lt(t," + start + "),0,if(lt(t," + (start + 1) + "),(t-" + start + ")/1,if(lt(t," + (start + duration - 1) + "),1,if(lt(t," + (start + duration) + "),1-(t-" + (start + duration - 1) + ")/1,0))))";
            } else if (step.animation === 'slide') {
                const targetX = x;
                x = "if(lt(t," + start + "),-text_w,if(lt(t," + (start + 1) + "),-text_w+(t-" + start + ")/1*(" + targetX + "+text_w)," + targetX + "))";
            }
            
            const enableStr = step.duration !== undefined ? ":enable='between(t," + start + "," + (start + duration) + ")'" : '';
            const outV = '[v_text_' + overlayCount + ']';
            
            // Use Nirmala UI for Windows (supports Devanagari) or Arial fallback
            const fontPath = fs.existsSync('C:\\Windows\\Fonts\\Nirmala.ttf') 
                ? 'C\\:/Windows/Fonts/Nirmala.ttf' 
                : 'C\\:/Windows/Fonts/arial.ttf';
            
            filterComplexParts.push(currentV + "drawtext=fontfile='" + fontPath + "':textfile='" + escapedTempTextFile + "':fontcolor=" + fontColor + ":fontsize=" + fontSize + ":x=" + x + ":y=" + y + ":alpha='" + alpha + "':box=1:boxcolor=black@0.5:boxborderw=8" + enableStr + outV);
            currentV = outV;
        }
    }

    const args = ['-y', ...preInputArgs];
    for (const inp of inputs) {
        if (inp.loop) {
            args.push('-stream_loop', '-1');
        }
        args.push('-i', '"' + inp.path + '"');
    }

    if (filterComplexParts.length > 0) {
        args.push('-filter_complex', '"' + filterComplexParts.join(';') + '"');
        args.push('-map', currentV);
        if (currentA) {
            args.push('-map', currentA);
        }
    } else {
        args.push('-map', '0:v');
        if (currentA) {
            args.push('-map', '0:a');
        }
    }
    args.push('-preset', 'ultrafast', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k', '-shortest');
    args.push('"' + outputPath + '"');

    const cmd = 'ffmpeg ' + args.join(' ');
    console.log('[Manus Agent] Dynamic complex FFmpeg command:', cmd);

    const cleanupTempFiles = () => {
        if (typeof tempFiles !== 'undefined') {
            tempFiles.forEach(tf => {
                try { if (fs.existsSync(tf)) fs.unlinkSync(tf); } catch(e){}
            });
        }
    };

    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err) => {
            if (err) {
                console.error('[Manus Agent] Complex FFmpeg failed:', err.message);
                // Fix Bug #3: Try a simpler fallback without overlays but WITH filters
                const fallbackArgs = ['-y', '-i', '"' + inputPath + '"'];
                if (vfStd.length > 0) {
                    fallbackArgs.push('-vf', '"' + vfStd.join(',') + '"');
                }
                if (hasAudio && afStd.length > 0) {
                    fallbackArgs.push('-af', '"' + afStd.join(',') + '"');
                }
                fallbackArgs.push('-preset', 'ultrafast', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k', '"' + outputPath + '"');
                
                const fallbackCmd = 'ffmpeg ' + fallbackArgs.join(' ');
                console.log('[Manus Agent] Running simple fallback:', fallbackCmd);
                
                exec(fallbackCmd, { maxBuffer: 50 * 1024 * 1024 }, (fbErr) => {
                    cleanupTempFiles();
                    if (fbErr) {
                        console.error('[Manus Agent] Fallback also failed:', fbErr.message);
                        reject(new Error('Failed to process video: ' + fbErr.message));
                    }
                    else resolve();
                });
            } else {
                cleanupTempFiles();
                resolve();
            }
        });
    });
}

// 5. Manus-style Edit Plan Parser
function validateAndSanitizeSteps(steps) {
    const validTypes = ['color_filter', 'brightness', 'contrast', 'saturation', 'speed', 'text_overlay', 'audio_effect', 'vignette', 'sharpen', 'blur', 'fade_in', 'zoom', 'flip', 'rotate', 'trim', 'search_download', 'overlay', 'audio_mix', 'side_by_side'];
    
    return steps.map(step => {
        if (!step || typeof step !== 'object') return null;
        if (!validTypes.includes(step.type)) return null;
        
        let validStep = { ...step };
        try {
            if (validStep.type === 'speed') {
                validStep.value = Math.max(0.5, Math.min(2.0, parseFloat(validStep.value) || 1.0));
            } else if (validStep.type === 'brightness') {
                validStep.value = Math.max(-1.0, Math.min(1.0, parseFloat(validStep.value) || 0.0));
            } else if (validStep.type === 'contrast') {
                validStep.value = Math.max(0.3, Math.min(3.0, parseFloat(validStep.value) || 1.0));
            } else if (validStep.type === 'saturation') {
                validStep.value = Math.max(0.0, Math.min(3.0, parseFloat(validStep.value) || 1.0));
            } else if (validStep.type === 'text_overlay') {
                if (!validStep.text || String(validStep.text).trim() === '') return null;
                validStep.fontSize = Math.max(16, Math.min(96, parseInt(validStep.fontSize) || 42));
                validStep.text = String(validStep.text);
            }
            return validStep;
        } catch (e) {
            return null;
        }
    }).filter(Boolean);
}

function parseEditPlan(aiResponse, userPrompt) {
    console.log('[Manus Agent] Raw AI response:', aiResponse);
    let plan = { 
        thought: 'Main is video ko optimize karunga user ki request ke hisab se.',
        plan: [
            { phase: 1, name: 'Asset Discovery', details: 'Scanning workspace and web', status: 'pending' },
            { phase: 2, name: 'Asset Acquisition', details: 'Downloading stock assets', status: 'pending' },
            { phase: 3, name: 'Video Assembly', details: 'Running FFmpeg layering & overlays', status: 'pending' },
            { phase: 4, name: 'Final Polish', details: 'Adding music and subtitles', status: 'pending' }
        ],
        requiresTools: false,
        steps: [],
        summary: ''
    };

    try {
        let cleaned = aiResponse.trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.steps && Array.isArray(parsed.steps)) {
                plan.steps = validateAndSanitizeSteps(parsed.steps);
                plan.summary = parsed.summary || '';
            }
            if (parsed.thought) plan.thought = parsed.thought;
            if (parsed.plan) plan.plan = parsed.plan;
            if (parsed.requiresTools !== undefined) plan.requiresTools = Boolean(parsed.requiresTools);
        }
    } catch (e) {
        console.log('[Manus Agent] JSON parse failed:', e.message);
        // Fallback inference if JSON completely fails
        plan.steps = inferStepsFromPrompt(userPrompt);
        if (plan.steps.length > 0) {
            plan.thought = "Fell back to rule-based inference due to JSON error.";
            plan.summary = "Applied edits based on keywords in your prompt.";
        }
    }

    if (plan.steps.length === 0 && plan.summary === '') {
        // One final fallback
        plan.steps = inferStepsFromPrompt(userPrompt);
        if (plan.steps.length > 0) {
            plan.summary = "Extracted steps based on keywords.";
        } else {
            console.log('[Manus Agent] WARNING: No valid steps found in AI response.');
            plan.summary = 'The AI could not parse the editing request.';
        }
    }
    return plan;
}

function inferStepsFromPrompt(prompt) {
    const steps = [];
    const p = String(prompt).toLowerCase();
    
    if (p.includes('grayscale') || p.includes('black and white') || p.includes('kala')) steps.push({ type: 'color_filter', filter: 'grayscale', stepName: 'Grayscale Filter' });
    if (p.includes('vintage') || p.includes('purana')) steps.push({ type: 'color_filter', filter: 'vintage', stepName: 'Vintage Filter' });
    if (p.includes('cinematic')) steps.push({ type: 'color_filter', filter: 'cinematic', stepName: 'Cinematic Filter' });
    
    if (p.includes('speed up') || p.includes('tez') || p.includes('1.5x') || p.includes('fast')) steps.push({ type: 'speed', value: 1.5, stepName: 'Speed Up 1.5x' });
    if (p.includes('slow') || p.includes('dheere') || p.includes('0.5x')) steps.push({ type: 'speed', value: 0.5, stepName: 'Slow Down 0.5x' });
    
    if (p.includes('bass boost') || p.includes('bass')) steps.push({ type: 'audio_effect', effect: 'bass_boost', stepName: 'Bass Boost' });
    if (p.includes('mute') || p.includes('awaaz band')) steps.push({ type: 'audio_effect', effect: 'mute', stepName: 'Mute Audio' });
    
    if (p.includes('blur')) steps.push({ type: 'blur', value: 3, stepName: 'Blur Filter' });
    if (p.includes('vignette')) steps.push({ type: 'vignette', stepName: 'Vignette Effect' });
    
    return steps;
}

// 6. Updated System Prompt acting as a High-Level Video Director / Orchestrator
const MANUS_AGENT_SYSTEM_PROMPT = "You are the MANUS Agentic Video Studio Director. You convert the user's prompt into a high-level thought process, a multi-phase plan, and executable editing/acquisition steps.\n\nYou operate inside a virtual workspace (a directory called '/uploads').\nYou can search the web and download assets (videos, images, music) using browser tools when the request cannot be satisfied by local files.\n\nCRITICAL RULES:\n1. User may write in Hindi, Hinglish, English, or any language. ALWAYS understand and convert to valid JSON steps regardless of input language. (e.g. \"tez karo\" = speed: 1.5, \"rangeen\" = saturation: 1.5, \"purana\" = vintage).\n2. Think first! Write a Hinglish \"thought\" describing how you will fulfill the request.\n3. Break the plan into 4 Phases:\n   - Phase 1: Asset Discovery (Browser/Search)\n   - Phase 2: Asset Acquisition (Download/Generation)\n   - Phase 3: Video Assembly (FFmpeg Layering)\n   - Phase 4: Final Polish (Audio/Subtitles)\n4. Return ONLY raw JSON matching the structure below. No markdown formatting, no backticks, no extra text.\n5. Set \"requiresTools\" to true if you need to search or download any external video, image, sound, or music.\n\nWORKSPACE CONTEXT:\nThe local workspace has the following files:\n{WORKSPACE_FILES}\n\nAVAILABLE OPERATIONS:\n- search_download: {\"stepName\":\"Search and download X\",\"type\":\"search_download\",\"query\":\"search term\",\"assetType\":\"video|image|audio\"}\n- overlay: {\"stepName\":\"Overlay X\",\"type\":\"overlay\",\"assetQuery\":\"search query of downloaded file\",\"x\":\"x coordinate\",\"y\":\"y coordinate\",\"startTime\":0,\"duration\":5,\"scale\":\"320:240\"}\n- audio_mix: {\"stepName\":\"Mix music\",\"type\":\"audio_mix\",\"assetQuery\":\"search query of downloaded music\",\"volume\":0.2,\"loop\":true}\n- side_by_side: {\"stepName\":\"Side-by-side video\",\"type\":\"side_by_side\",\"assetQuery\":\"search query of video\"}\n- text_overlay: {\"stepName\":\"Draw text\",\"type\":\"text_overlay\",\"text\":\"TEXT IN ANY LANGUAGE\",\"position\":\"center|top|bottom|top-left|top-right|bottom-left|bottom-right\",\"fontSize\":48,\"fontColor\":\"white\",\"startTime\":0,\"duration\":5,\"animation\":\"none|fade|slide\"}\n- color_filter: {\"stepName\":\"Color filter\",\"type\":\"color_filter\",\"filter\":\"grayscale|sepia|vintage|high_contrast|negative|vibrant|warm|cool|cinematic\"}\n- brightness: {\"stepName\":\"Brightness\",\"type\":\"brightness\",\"value\":0.2} (range -1.0 to 1.0)\n- contrast: {\"stepName\":\"Contrast\",\"type\":\"contrast\",\"value\":1.5} (range 0.3 to 3.0)\n- saturation: {\"stepName\":\"Saturation\",\"type\":\"saturation\",\"value\":1.5} (range 0.0 to 3.0)\n- speed: {\"stepName\":\"Speed\",\"type\":\"speed\",\"value\":1.5} (range 0.5 to 2.0)\n- audio_effect: {\"stepName\":\"Audio effect\",\"type\":\"audio_effect\",\"effect\":\"bass_boost|treble_boost|volume_up|volume_down|mute|normalize|echo\"}\n- vignette: {\"stepName\":\"Vignette\",\"type\":\"vignette\"}\n- sharpen: {\"stepName\":\"Sharpen\",\"type\":\"sharpen\"}\n- blur: {\"stepName\":\"Blur\",\"type\":\"blur\",\"value\":3} (range 1-10)\n- fade_in: {\"stepName\":\"Fade-in\",\"type\":\"fade_in\",\"duration\":1.0}\n- zoom: {\"stepName\":\"Zoom\",\"type\":\"zoom\",\"value\":1.2} (range 1.05-2.0)\n- flip: {\"stepName\":\"Flip\",\"type\":\"flip\",\"direction\":\"horizontal|vertical\"}\n- rotate: {\"stepName\":\"Rotate\",\"type\":\"rotate\",\"angle\":90|180|270}\n- trim: {\"stepName\":\"Trim\",\"type\":\"trim\",\"start\":0,\"end\":30}\n\nJSON OUTPUT STRUCTURE:\n{\n  \"thought\": \"Hinglish thought detailing how you plan to edit the video...\",\n  \"plan\": [\n    { \"phase\": 1, \"name\": \"Asset Discovery\", \"details\": \"...\", \"status\": \"pending\" },\n    { \"phase\": 2, \"name\": \"Asset Acquisition\", \"details\": \"...\", \"status\": \"pending\" },\n    { \"phase\": 3, \"name\": \"Video Assembly\", \"details\": \"...\", \"status\": \"pending\" },\n    { \"phase\": 4, \"name\": \"Final Polish\", \"details\": \"...\", \"status\": \"pending\" }\n  ],\n  \"requiresTools\": true,\n  \"steps\": [...],\n  \"summary\": \"Short english summary of the plan\"\n}";

// 7. Studio Planning Endpoint (Agent Planning)
app.post('/api/studio/plan', async (req, res) => {
    const { prompt, videoContext, videoName, currentEdits, isRefine, history = [] } = req.body;
    if (!prompt) return res.status(400).json({ error: 'No prompt provided.' });

    const currentEditsInfo = currentEdits && Array.isArray(currentEdits)
        ? '\n\nCurrent edits already applied:\n' + JSON.stringify(currentEdits) + '\n\nThe user wants to MODIFY or ADD to these edits. Return the COMPLETE new set of steps (including any you want to keep from the current edits).'
        : '';

    const contextAddendum = videoContext
        ? '\n\nVideo analysis context for reference:\n' + JSON.stringify(videoContext).substring(0, 3000) + '\nVideo Name: ' + (videoName || 'My Video')
        : '';

    const workspaceList = getWorkspaceFileList();
    const workspaceString = workspaceList.length > 0
        ? workspaceList.map(f => '- ' + f.name + ' (' + f.type + ', size: ' + f.size + ' bytes)').join('\n')
        : 'No files in workspace yet.';

    try {
        console.log('[Manus Agent] Planning task...');
        console.log('[Manus Agent] Prompt:', prompt);

        const customPrompt = MANUS_AGENT_SYSTEM_PROMPT
            .replace('{WORKSPACE_FILES}', workspaceString)
            + currentEditsInfo 
            + contextAddendum;

        let messages = [];
        if (isRefine) {
            messages = [
                { role: 'system', content: customPrompt },
                ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: prompt }
            ];
        } else {
            messages = [
                { role: 'system', content: customPrompt },
                { role: 'user', content: prompt }
            ];
        }

        const aiResponse = await callManusWithFallback(messages, 1500);
        const plan = parseEditPlan(aiResponse, prompt);

        if (plan.steps.length === 0) {
            return res.status(400).json({
                error: 'Could not understand the editing request. Please try a more specific prompt.'
            });
        }

        res.json({
            success: true,
            thought: plan.thought,
            plan: plan.plan,
            requiresTools: plan.requiresTools,
            status: 'thinking',
            steps: plan.steps,
            summary: plan.summary || 'Planned edits successfully.'
        });

    } catch (err) {
        console.error('[Manus Agent] Planning error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 8. Studio Execution Endpoint (Agent Execution - Plan-Act-Verify loop)
app.post('/api/studio/execute', async (req, res) => {
    const { steps, videoPath } = req.body;
    if (!steps || !Array.isArray(steps)) return res.status(400).json({ error: 'No steps provided.' });
    if (!videoPath) return res.status(400).json({ error: 'No video path provided.' });

    if (!videoPath.startsWith('/uploads/')) {
        return res.status(400).json({ error: 'Invalid video path.' });
    }

    const inputPath = path.join(__dirname, videoPath);
    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Source video file not found.' });
    }

    try {
        console.log('[Manus Agent] ===== Executing Plan-Act-Verify Agentic Loop =====');
        const queryToPath = {};

        // Act & Verify loop: Asset Acquisition
        for (const step of steps) {
            if (step.type === 'search_download') {
                console.log('[Manus Agent] [Act] Searching & downloading: "' + step.query + '" (' + step.assetType + ')...');
                try {
                    const filename = await searchAndDownloadAsset(step.query, step.assetType);
                    const filePath = path.join(uploadDir, filename);
                    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                        console.log('[Manus Agent] [Verify] Successfully verified downloaded asset: ' + filename);
                        queryToPath[step.query] = filename;
                    } else {
                        throw new Error('Downloaded file is empty or missing: ' + filename);
                    }
                } catch (err) {
                    console.error('[Manus Agent] [Act-Verify Failed] for "' + step.query + '":', err.message);
                    let fallbackFile = '';
                    if (step.assetType === 'video') fallbackFile = 'fallback_video.mp4';
                    else if (step.assetType === 'audio') fallbackFile = 'fallback_audio.mp3';
                    else fallbackFile = 'fallback_image.jpg';

                    const dest = path.join(uploadDir, fallbackFile);
                    if (!fs.existsSync(dest)) {
                        let fallbackUrl = '';
                        if (step.assetType === 'video') fallbackUrl = getStockFallbackVideo(step.query);
                        else if (step.assetType === 'audio') fallbackUrl = getStockFallbackAudio(step.query);
                        else fallbackUrl = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(step.query) + '?width=1280&height=720&nologo=true';

                        try {
                            const response = await fetch(fallbackUrl);
                            fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
                        } catch (fbErr) {
                            console.error('[Manus Agent] Fallback download failed:', fbErr.message);
                        }
                    }
                    queryToPath[step.query] = fallbackFile;
                    console.log('[Manus Agent] [Verify Fallback] Set query path to fallback file: ' + fallbackFile);
                }
            }
        }

        const outputFilename = 'edited-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + '.mp4';
        const outputPath = path.join(uploadDir, outputFilename);
        const outputUrl = '/uploads/' + outputFilename;

        console.log('[Manus Agent] [Act] Assembling video layout and layers...');
        await editVideoWithStepsAgent(inputPath, outputPath, steps, queryToPath);

        // Final Verification
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            console.log('[Manus Agent] [Verify] Executed plan successfully.');
            res.json({
                success: true,
                editedVideoUrl: outputUrl
            });
        } else {
            throw new Error('Rendered video is empty or missing.');
        }

    } catch (err) {
        console.error('[Manus Agent] Execution error:', err);
        res.status(500).json({ error: err.message });
    }
});



// ── YouTube Direct Publish API ──────────────────────────────────────────────
const { Transform } = require('stream');

class ProgressTracker extends Transform {
    constructor(totalSize, onProgress) {
        super();
        this.totalSize = totalSize;
        this.uploadedBytes = 0;
        this.onProgress = onProgress;
    }
    _transform(chunk, encoding, callback) {
        this.uploadedBytes += chunk.length;
        const progress = Math.min(Math.round((this.uploadedBytes / this.totalSize) * 100), 99); // Cap at 99 until finished
        this.onProgress(progress);
        this.push(chunk);
        callback();
    }
}

const youtubeUploads = {};

app.post('/api/youtube/publish', async (req, res) => {
    const { accessToken, videoPath, title, description, tags, privacyStatus } = req.body;

    if (!accessToken) return res.status(400).json({ error: 'Google Access Token is required.' });
    if (!videoPath) return res.status(400).json({ error: 'Video path is required.' });

    const filename = path.basename(videoPath);
    const fullPath = path.join(__dirname, 'uploads', filename);

    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Video file not found on server.' });
    }

    const fileSize = fs.statSync(fullPath).size;
    const uploadId = 'yt-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
    youtubeUploads[uploadId] = { progress: 0, status: 'initiating', videoId: null, error: null };

    // Send instant response with job ID
    res.json({ success: true, uploadId });

    // Asynchronously perform the upload to avoid request timeout on large files
    (async () => {
        try {
            const metadata = {
                snippet: {
                    title: title || 'VeerAlyze AI Video',
                    description: description || 'Analyzed with VeerAlyze AI Engine',
                    tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
                    categoryId: '22'
                },
                status: {
                    privacyStatus: privacyStatus || 'unlisted'
                }
            };

            // Step 1: Initiate Resumable Session
            const sessionRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-Upload-Content-Length': fileSize,
                    'X-Upload-Content-Type': 'video/*'
                },
                body: JSON.stringify(metadata)
            });

            if (!sessionRes.ok) {
                const errText = await sessionRes.text();
                throw new Error('Google Session creation failed: ' + errText);
            }

            const uploadUrl = sessionRes.headers.get('Location');
            if (!uploadUrl) {
                throw new Error('Google Upload Location header missing.');
            }

            youtubeUploads[uploadId].status = 'uploading';

            // Step 2: Stream File via ProgressTracker
            const progressTracker = new ProgressTracker(fileSize, (prog) => {
                youtubeUploads[uploadId].progress = prog;
            });

            const uploadRes = await fetch(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': fileSize,
                    'Content-Type': 'video/*'
                },
                body: fs.createReadStream(fullPath).pipe(progressTracker)
            });

            if (!uploadRes.ok) {
                const errText = await uploadRes.text();
                throw new Error('YouTube video upload call failed: ' + errText);
            }

            const uploadResult = await uploadRes.json();
            const videoId = uploadResult.id;

            if (videoId) {
                youtubeUploads[uploadId].status = 'completed';
                youtubeUploads[uploadId].progress = 100;
                youtubeUploads[uploadId].videoId = videoId;
            } else {
                throw new Error('Upload completed but video ID was not returned.');
            }

        } catch (err) {
            console.error('[YouTube Upload Error]:', err.message);
            youtubeUploads[uploadId].status = 'failed';
            youtubeUploads[uploadId].error = err.message;
        }
    })();
});

app.get('/api/youtube/upload-status/:uploadId', (req, res) => {
    const job = youtubeUploads[req.params.uploadId];
    if (!job) return res.status(404).json({ error: 'Upload job not found.' });
    res.json(job);
});

// ── Share Route: serve index.html so frontend handles shared result ────────
// ── Privacy Policy Route ──────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/share/:shareId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log('[Manus Agent] VeeraLyse Agentic Studio running on port ' + PORT);
});
